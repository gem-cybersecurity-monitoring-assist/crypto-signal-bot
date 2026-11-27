# backend/services/portfolio/service.py
"""
Portfolio & PnL service — paper trading engine.

Handles:
  - Account management (single default account per session)
  - Order lifecycle: MARKET (instant fill) + LIMIT (pending fill on price cross)
  - FIFO position tracking with realized PnL
  - Unrealized PnL via live prices
  - Equity = cash + market value of remaining inventory
  - Drawdown tracking vs peak equity
  - Equity snapshots (persisted every N seconds)
  - DB persistence for orders, trades, positions, equity snapshots

All amounts in USDT. Paper mode only. No live execution.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from collections import defaultdict
from dataclasses import dataclass, field
from decimal import Decimal, ROUND_HALF_UP, ROUND_DOWN
from typing import Coroutine, Dict, List, Optional, Tuple

from backend.services.market_data.service import get_price

log = logging.getLogger(__name__)

# Lazy reference for test patching — populated on first use
_evaluate_order = None  # type: ignore

PRECISION   = Decimal("0.00000001")
FEE_RATE    = Decimal("0.001")          # 0.10% taker fee (paper)
STARTING_CASH = Decimal("10000.0")
_SNAPSHOT_INTERVAL = 300                # 5 min equity snapshots
_DEFAULT_ACCOUNT_ID = "paper-default"


# ─────────────────────────────────────────────────────────────────
# Internal data structures
# ─────────────────────────────────────────────────────────────────

@dataclass
class Lot:
    symbol:     str
    qty:        Decimal
    entry_price: Decimal
    opened_at:  int
    order_id:   str


@dataclass
class OrderState:
    id:         str
    account_id: str
    symbol:     str
    side:       str         # BUY | SELL
    order_type: str         # MARKET | LIMIT
    qty:        Decimal
    price:      Optional[Decimal]
    status:     str         # PENDING | FILLED | CANCELLED
    mode:       str = "paper"
    created_at: int = field(default_factory=lambda: int(time.time()))
    updated_at: int = field(default_factory=lambda: int(time.time()))


@dataclass
class TradeState:
    id:          int
    order_id:    str
    account_id:  str
    symbol:      str
    qty:         Decimal
    price:       Decimal
    fee:         Decimal
    side:        str
    realized_pnl: Optional[Decimal]
    executed_at: int


@dataclass
class PositionState:
    symbol:         str
    qty:            Decimal       # signed
    avg_entry_price: Decimal
    realized_pnl:   Decimal
    unrealized_pnl: Decimal


@dataclass
class EquitySnapshot:
    account_id:  str
    equity:      float
    cash:        float
    unrealized:  float
    drawdown_pct: float
    max_equity:  float
    timestamp:   int


# ─────────────────────────────────────────────────────────────────
# In-process state
# ─────────────────────────────────────────────────────────────────

_cash:          Decimal = STARTING_CASH
_lots:          Dict[str, List[Lot]]   = defaultdict(list)
_orders:        Dict[str, OrderState]  = {}
_trades:        List[TradeState]       = []
_trade_counter: int = 0
_peak_equity:   Decimal = STARTING_CASH
_portfolio_tasks: set[asyncio.Task] = set()
_persistence_tasks: set[asyncio.Task] = set()
_portfolio_stop: Optional[asyncio.Event] = None
_portfolio_starting = False
_SHUTDOWN_TIMEOUT = 15.0
_fill_lock = asyncio.Lock()
_peak_lock = asyncio.Lock()
_state_revision = 0
_recovery_blocked: Optional[str] = None   # set when durable state is ambiguous


class PortfolioRecoveryError(RuntimeError):
    """Durable paper state is incoherent or ambiguous; trading must stay blocked."""


def require_ephemeral_reset() -> None:
    """Never erase durable history or clear a recovery halt via a RAM-only reset."""
    if _db_ready() or _recovery_blocked is not None or _portfolio_starting or _fill_lock.locked():
        raise PortfolioRecoveryError("Durable portfolio reset requires a reviewed ledger migration")


def _schedule_persistence(coro: Coroutine) -> None:
    """Retain existing asynchronous writes until their completion."""
    task = asyncio.create_task(coro, name="portfolio_persistence")
    _persistence_tasks.add(task)

    def completed(done: asyncio.Task) -> None:
        _persistence_tasks.discard(done)
        if not done.cancelled() and done.exception() is not None:
            log.warning("[portfolio] asynchronous persistence failed")

    task.add_done_callback(completed)


async def _next_tick(interval: float) -> bool:
    """Wake sleeping loops immediately on shutdown, finish the current tick."""
    stop = _portfolio_stop
    if stop is None:
        return False
    try:
        await asyncio.wait_for(stop.wait(), timeout=interval)
        return False
    except asyncio.TimeoutError:
        return not stop.is_set()



def reset_portfolio(starting_cash: Decimal = STARTING_CASH) -> None:
    global _cash, _lots, _orders, _trades, _trade_counter, _peak_equity, _state_revision
    global _recovery_blocked
    _recovery_blocked = None
    _state_revision += 1
    _cash = starting_cash
    _lots.clear()
    _orders.clear()
    _trades.clear()
    _trade_counter = 0
    _peak_equity = starting_cash


# ─────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────

class PortfolioValuationUnavailable(RuntimeError):
    """A complete, fresh mark set is required for portfolio valuation."""


def validated_mark(snap, symbol: str) -> Decimal:
    """Legacy paper REST observation only, never fast-path execution evidence."""
    from backend.services.market_data.service import PRICE_STALE_THRESHOLD_SECONDS
    if (
        snap.stale is not False
        or snap.market_data_mode not in ("live", "paper_live")
        or snap.symbol != symbol
        or not isinstance(snap.source, str) or not snap.source
        or snap.source.startswith("cache:")
        or type(snap.fetched_at) is not int
        or not 0 <= int(time.time()) - snap.fetched_at <= PRICE_STALE_THRESHOLD_SECONDS
    ):
        raise PortfolioValuationUnavailable("Fresh portfolio price unavailable")
    mark = _qty(snap.price)
    if not mark.is_finite() or mark <= 0:
        raise PortfolioValuationUnavailable("Invalid portfolio mark")
    return mark


def _qty(v) -> Decimal:
    return Decimal(str(v)).quantize(PRECISION, rounding=ROUND_HALF_UP)

def _usd(v) -> Decimal:
    return Decimal(str(v)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def _fifo_consume(
    lots: List[Lot], qty_to_close: Decimal, fill_price: Decimal,
) -> Tuple[List[Lot], Decimal, Decimal]:
    """Pure FIFO close: return (remaining_lots, avg_cost_basis, gross_realized)."""
    remaining = qty_to_close
    total_cost = Decimal("0")
    consumed   = Decimal("0")
    new_lots: List[Lot] = []

    for lot in lots:
        if remaining <= 0:
            new_lots.append(lot)
            continue
        take = min(lot.qty, remaining)
        total_cost += take * lot.entry_price
        consumed   += take
        remaining  -= take
        if lot.qty > take:
            new_lots.append(Lot(
                symbol=lot.symbol, qty=lot.qty - take,
                entry_price=lot.entry_price,
                opened_at=lot.opened_at, order_id=lot.order_id,
            ))

    if consumed == 0:
        return new_lots, Decimal("0"), Decimal("0")

    avg_cost = total_cost / consumed
    realized = fill_price * consumed - total_cost
    return new_lots, avg_cost, realized.quantize(PRECISION, rounding=ROUND_HALF_UP)


def _fifo_close(
    symbol: str,
    qty_to_close: Decimal,
    fill_price: Decimal,
) -> Tuple[Decimal, Decimal]:
    """FIFO close in place on _lots: return (avg_cost_basis, realized_pnl)."""
    new_lots, avg_cost, realized = _fifo_consume(_lots.get(symbol, []), qty_to_close, fill_price)
    _lots[symbol] = new_lots
    return avg_cost, realized


def _apply_fill(
    cash: Decimal, lots: List[Lot], side: str, symbol: str, qty: Decimal,
    price: Decimal, fee: Decimal, order_id: str, now: int,
) -> Optional[Tuple[Decimal, List[Lot], Decimal]]:
    """Pure ledger step shared by live fills and recovery replay.

    Returns (new_cash, new_lots, realized_pnl) or None if the fill is invalid.
    """
    cost = qty * price
    if side == "BUY":
        total_cost = cost + fee
        if total_cost > cash:
            return None
        return (
            cash - total_cost,
            list(lots) + [Lot(symbol=symbol, qty=qty, entry_price=price,
                              opened_at=now, order_id=order_id)],
            -fee,
        )
    if side == "SELL":
        if fee > cost or qty > sum((l.qty for l in lots), Decimal("0")):
            return None
        new_lots, _, gross = _fifo_consume(lots, qty, price)
        return cash + cost - fee, new_lots, gross - fee
    return None


def _get_position(symbol: str) -> PositionState:
    lots = _lots.get(symbol, [])
    if not lots:
        return PositionState(symbol, Decimal("0"), Decimal("0"), Decimal("0"), Decimal("0"))
    total_qty  = sum(l.qty for l in lots)
    total_cost = sum(l.qty * l.entry_price for l in lots)
    avg_entry  = total_cost / total_qty if total_qty else Decimal("0")
    realized   = sum(
        t.realized_pnl for t in _trades
        if t.symbol == symbol and t.realized_pnl is not None
    )
    return PositionState(
        symbol=symbol, qty=total_qty,
        avg_entry_price=avg_entry.quantize(PRECISION, rounding=ROUND_HALF_UP),
        realized_pnl=realized, unrealized_pnl=Decimal("0"),
    )


# ─────────────────────────────────────────────────────────────────
# Order execution
# ─────────────────────────────────────────────────────────────────

async def submit_order(
    symbol: str,
    side: str,
    order_type: str,
    qty: float,
    price: Optional[float] = None,
    account_id: str = _DEFAULT_ACCOUNT_ID,
) -> OrderState:
    """
    Submit a paper order.

    MARKET: fill immediately at current live price.
    LIMIT:  store as PENDING; filled by _limit_fill_loop when price crosses.
    """
    global _cash, _peak_equity

    order = OrderState(
        id=str(uuid.uuid4()),
        account_id=account_id,
        symbol=symbol.upper(),
        side=side.upper(),
        order_type=order_type.upper(),
        qty=_qty(qty),
        price=_qty(price) if price else None,
        status="PENDING",
    )
    # Do not publish a pending limit until risk admission and durable order
    # recording finish; cancellation and the limit loop share this lock.
    async with _fill_lock:
        if (
            _recovery_blocked is not None
            or order.account_id != _DEFAULT_ACCOUNT_ID
            or order.side not in ("BUY", "SELL")
            or order.order_type not in ("MARKET", "LIMIT")
            or not order.qty.is_finite() or order.qty <= 0
            or (order.order_type == "LIMIT" and
                (order.price is None or not order.price.is_finite() or order.price <= 0))
        ):
            order.status = "CANCELLED"
        elif order.order_type == "MARKET":
            await _fill_order_locked(order)
        elif not await _apply_risk_gate(order, order.price):
            order.status = "CANCELLED"
            order.updated_at = int(time.time())

        if _recovery_blocked is None and order.status != "FILLED":
            await _persist_order(order)
        _orders[order.id] = order
    return order


async def _apply_risk_gate(order: OrderState, price: Optional[Decimal]) -> bool:
    """A missing, malformed or unavailable decision never grants permission."""
    try:
        fn = _evaluate_order
        if fn is None:
            # Preserve the existing deferred service lookup: risk reads portfolio state.
            import importlib
            fn = importlib.import_module("backend.services.risk_gate.service").evaluate_order
        decision = await fn(symbol=order.symbol, side=order.side,
                            qty=float(order.qty), price=float(price) if price is not None else None)
        multiplier = Decimal(str(decision.size_multiplier))
        if (
            decision.approved is not True or decision.kill_switch is not False
            or not multiplier.is_finite() or not Decimal("0") < multiplier <= Decimal("1")
        ):
            return False
        adjusted = (order.qty * multiplier).quantize(PRECISION, rounding=ROUND_DOWN)
        if adjusted <= 0:
            return False
        order.qty = adjusted
        return True
    except Exception:
        log.warning("[portfolio] risk decision unavailable — paper order blocked")
        return False


async def _fill_order(order: OrderState) -> None:
    """Serialize paper fills within the existing process and recheck risk."""
    async with _fill_lock:
        await _fill_order_locked(order)


async def _fill_order_locked(order: OrderState) -> None:
    global _cash, _peak_equity, _trade_counter, _state_revision, _recovery_blocked

    if order.status != "PENDING":
        return
    revision = _state_revision

    def cancel() -> None:
        if order.status in ("PENDING", "FILLING"):
            order.status = "CANCELLED"
            order.updated_at = int(time.time())

    if _recovery_blocked is not None or any(t.order_id == order.id for t in _trades):
        cancel()  # blocked, or duplicate fill identity
        return

    try:
        snap = await get_price(order.symbol)
        fill_price = validated_mark(snap, order.symbol)
    except Exception:
        cancel()
        return

    if order.status != "PENDING":
        return
    if order.order_type == "LIMIT":
        if order.price is None or (
            (order.side == "BUY" and fill_price > order.price)
            or (order.side == "SELL" and fill_price < order.price)
        ):
            return
    if not await _apply_risk_gate(order, fill_price):
        cancel()
        return
    # A cancel can arrive while price or risk is being awaited. Recheck the
    # same quote after the risk call and before any state mutation.
    if order.status != "PENDING":
        return
    if revision != _state_revision:
        cancel()
        return
    try:
        validated_mark(snap, order.symbol)
    except Exception:
        cancel()
        return

    now = int(time.time())
    if order.side == "SELL":
        held = sum((lot.qty for lot in _lots.get(order.symbol, [])), Decimal("0"))
        order.qty = min(order.qty, held)
    if order.side not in ("BUY", "SELL") or not order.qty.is_finite() or order.qty <= 0:
        cancel()
        return
    cost = order.qty * fill_price
    fee = (cost * FEE_RATE).quantize(PRECISION, rounding=ROUND_HALF_UP)
    # Stage the whole ledger mutation without touching live state, commit it
    # durably, and only then publish it in memory. Acquisition fees are
    # recorded as realized expenses (realized_pnl = -fee on BUY).
    applied = _apply_fill(_cash, _lots.get(order.symbol, []), order.side, order.symbol,
                          order.qty, fill_price, fee, order.id, now)
    if applied is None:
        cancel()
        return
    new_cash, new_lots, realized_pnl = applied
    trade = TradeState(
        id=_trade_counter + 1, order_id=order.id, account_id=order.account_id,
        symbol=order.symbol, qty=order.qty, price=fill_price, fee=fee,
        side=order.side, realized_pnl=realized_pnl, executed_at=now,
    )
    # "FILLING" blocks cancel_pending_order while the commit is awaited.
    order.status = "FILLING"
    order.updated_at = now
    try:
        await _commit_fill(order, trade, new_cash, new_lots)
    except asyncio.CancelledError:
        _recovery_blocked = "Cancelled during durable fill commit; reconcile before resuming"
        order.status = "FILLING"
        raise
    except Exception as exc:
        # A timeout/disconnect can occur after a database commit. Do not claim
        # rollback, or let subsequent best-effort persistence overwrite it.
        _recovery_blocked = "Durable fill outcome requires reconciliation"
        log.warning("[portfolio] atomic fill outcome unverified: %s", type(exc).__name__)
        from sqlalchemy.exc import IntegrityError
        if isinstance(exc, IntegrityError):
            cancel()  # database rejected the transaction
        else:
            # A lost commit response is not a confirmed cancellation.
            order.status = "FILLING"
        return

    order.status = "FILLED"
    _cash = new_cash
    _lots[order.symbol] = new_lots
    _trade_counter = trade.id
    _state_revision += 1
    _trades.append(trade)
    try:
        await _compute_equity()
        # _compute_equity records a new peak durably before returning.
    except PortfolioValuationUnavailable:
        log.warning("[portfolio] marked equity unavailable after paper fill")
    log.info("[portfolio] paper fill %s %s", order.side, order.symbol)


# ─────────────────────────────────────────────────────────────────
# Equity & PnL
# ─────────────────────────────────────────────────────────────────

async def _marked_portfolio() -> tuple[Decimal, Decimal, Decimal, list[dict]]:
    """One complete mark set for cash, equity, P&L and position breakdown."""
    if _recovery_blocked is not None:
        raise PortfolioValuationUnavailable("Portfolio recovery blocked")
    revision = _state_revision
    cash = _cash
    lots_by_symbol = {symbol: tuple(lots) for symbol, lots in _lots.items() if lots}
    trades = tuple(_trades)
    realized_by_symbol = defaultdict(Decimal)
    for trade in trades:
        if trade.realized_pnl is not None:
            realized_by_symbol[trade.symbol] += trade.realized_pnl
    market_value = Decimal("0")
    unrealized_total = Decimal("0")
    positions = []
    for symbol, lots in lots_by_symbol.items():
        try:
            mark = validated_mark(await get_price(symbol), symbol)
        except Exception as exc:
            raise PortfolioValuationUnavailable("Complete portfolio marks unavailable") from exc
        total_qty = sum(l.qty for l in lots)
        total_cost = sum(l.qty * l.entry_price for l in lots)
        avg_entry = total_cost / total_qty
        notional = mark * total_qty
        unrealized = notional - total_cost
        market_value += notional
        unrealized_total += unrealized
        realized = realized_by_symbol[symbol]
        positions.append({
            "symbol": symbol, "qty": float(total_qty),
            "avg_entry_price": float(_usd(avg_entry)), "mark_price": float(mark),
            "unrealized_pnl": float(_usd(unrealized)), "realized_pnl": float(_usd(realized)),
        })
    if revision != _state_revision or _recovery_blocked is not None:
        raise PortfolioValuationUnavailable("Portfolio changed or requires recovery")
    return cash, _usd(cash + market_value), _usd(unrealized_total), positions


async def _compute_equity() -> Decimal:
    revision = _state_revision
    _, equity, _, _ = await _marked_portfolio()
    await _record_peak(equity, revision)
    return equity


async def get_portfolio_summary(account_id: str = _DEFAULT_ACCOUNT_ID) -> dict:
    """Return a consistent complete marked portfolio summary, or unavailable."""
    global _peak_equity
    if account_id != _DEFAULT_ACCOUNT_ID:
        raise PortfolioValuationUnavailable("Portfolio account scope unavailable")
    if _recovery_blocked is not None:
        raise PortfolioValuationUnavailable("Portfolio recovery blocked")
    now = int(time.time())
    revision = _state_revision
    cash, equity, unrealized, positions = await _marked_portfolio()
    await _record_peak(equity, revision)
    drawdown = float((_peak_equity - equity) / _peak_equity * 100) if _peak_equity > 0 else 0.0

    total_realized   = sum(
        t.realized_pnl for t in _trades if t.realized_pnl is not None
    ) or Decimal("0")
    wins = [t for t in _trades if t.side == "SELL" and t.realized_pnl is not None and t.realized_pnl > 0]
    trade_count = len([t for t in _trades if t.side == "SELL"])
    win_rate = (len(wins) / trade_count * 100) if trade_count > 0 else 0.0

    return {
        "account_id":      account_id,
        "cash_balance":    float(cash),
        "equity":          float(equity),
        "max_equity":      float(_peak_equity),
        "drawdown_pct":    round(drawdown, 4),
        "total_realized_pnl":   float(total_realized.quantize(Decimal("0.01"))),
        "total_unrealized_pnl": float(unrealized),
        "trade_count":     trade_count,
        "win_rate_pct":    round(win_rate, 2),
        "open_positions":  positions,
        "as_of":           now,
    }


def get_trades(limit: int = 50, symbol: Optional[str] = None) -> List[dict]:
    trades = _trades if not symbol else [t for t in _trades if t.symbol == symbol.upper()]
    trades = sorted(trades, key=lambda t: t.executed_at, reverse=True)[:limit]
    return [
        {
            "id":          t.id,
            "order_id":    t.order_id,
            "symbol":      t.symbol,
            "side":        t.side,
            "qty":         float(t.qty),
            "price":       float(t.price),
            "fee":         float(t.fee),
            "realized_pnl": float(t.realized_pnl) if t.realized_pnl is not None else None,
            "executed_at": t.executed_at,
        }
        for t in trades
    ]


def get_orders(status: Optional[str] = None, limit: int = 50) -> List[dict]:
    orders = list(_orders.values())
    if status:
        orders = [o for o in orders if o.status == status.upper()]
    orders = sorted(orders, key=lambda o: o.created_at, reverse=True)[:limit]
    return [
        {
            "id":         o.id,
            "symbol":     o.symbol,
            "side":       o.side,
            "order_type": o.order_type,
            "qty":        float(o.qty),
            "price":      float(o.price) if o.price else None,
            "status":     o.status,
            "created_at": o.created_at,
            "updated_at": o.updated_at,
        }
        for o in orders
    ]


def get_order(order_id: str) -> Optional[dict]:
    o = _orders.get(order_id)
    if not o:
        return None
    return {
        "id": o.id, "symbol": o.symbol, "side": o.side,
        "order_type": o.order_type, "qty": float(o.qty),
        "price": float(o.price) if o.price else None,
        "status": o.status, "created_at": o.created_at, "updated_at": o.updated_at,
    }


# ─────────────────────────────────────────────────────────────────
# Equity snapshot loop
# ─────────────────────────────────────────────────────────────────

async def _snapshot_loop() -> None:
    global _peak_equity
    while await _next_tick(_SNAPSHOT_INTERVAL):
        try:
            revision = _state_revision
            cash, equity, unrealized, _ = await _marked_portfolio()
            await _record_peak(equity, revision)
            drawdown = float((_peak_equity - equity) / _peak_equity * 100) if _peak_equity > 0 else 0.0
            snap = EquitySnapshot(
                account_id=_DEFAULT_ACCOUNT_ID,
                equity=float(equity),
                cash=float(cash),
                unrealized=float(unrealized),
                drawdown_pct=drawdown,
                max_equity=float(_peak_equity),
                timestamp=int(time.time()),
            )
            await _persist_snapshot(snap)
            log.info("[portfolio] equity=%.2f cash=%.2f drawdown=%.2f%%",
                     snap.equity, snap.cash, snap.drawdown_pct)
        except Exception as exc:
            log.warning("[portfolio] snapshot error: %s", exc)


# ─────────────────────────────────────────────────────────────────
# LIMIT order fill loop
# ─────────────────────────────────────────────────────────────────

async def _limit_fill_loop() -> None:
    """Check pending LIMIT orders every 10s and fill if price has crossed."""
    while await _next_tick(10):
        pending = [o for o in _orders.values() if o.status == "PENDING" and o.order_type == "LIMIT"]
        for order in pending:
            try:
                snap = await get_price(order.symbol)
                mark = validated_mark(snap, order.symbol)
                limit = order.price
                if ((order.side == "BUY" and mark <= limit)
                        or (order.side == "SELL" and mark >= limit)):
                    async with _fill_lock:
                        await _fill_order_locked(order)
                        if _recovery_blocked is None and order.status == "CANCELLED":
                            await _persist_order(order)
            except Exception as exc:
                log.debug("limit fill check error %s: %s", order.id[:8], exc)


# ─────────────────────────────────────────────────────────────────
# DB persistence (best-effort)
# ─────────────────────────────────────────────────────────────────

async def _persist_order(order: OrderState) -> None:
    """Persist admission/rejection before acknowledging a non-filled order."""
    global _recovery_blocked
    if not _db_ready():
        if not (_portfolio_tasks or _portfolio_starting):
            return  # isolated in-memory test compatibility
        _recovery_blocked = "Durable portfolio database unavailable"
        raise PortfolioRecoveryError(_recovery_blocked)
    try:
        from backend.db.session import get_session
        from backend.db.models import PaperOrderRecord
        async with get_session() as session:
            async with session.begin():
                existing = await session.get(PaperOrderRecord, order.id)
                if existing:
                    if (existing.account_id != order.account_id or
                            existing.status not in ("PENDING", order.status)):
                        raise PortfolioRecoveryError("Durable order identity/status conflict")
                    existing.status = order.status
                    existing.updated_at = order.updated_at
                else:
                    session.add(PaperOrderRecord(
                        id=order.id, account_id=order.account_id,
                        symbol=order.symbol, side=order.side,
                        order_type=order.order_type, qty=float(order.qty),
                        price=float(order.price) if order.price else None,
                        status=order.status, mode=order.mode,
                        created_at=order.created_at, updated_at=order.updated_at,
                    ))
    except asyncio.CancelledError:
        _recovery_blocked = "Order persistence outcome requires reconciliation"
        raise
    except Exception as exc:
        _recovery_blocked = "Order persistence outcome requires reconciliation"
        raise PortfolioRecoveryError(_recovery_blocked) from exc


def _db_ready() -> bool:
    """True once init_db() has published a session factory."""
    from backend.db import session as db_session
    return db_session._session_factory is not None


def _fill_key(order_id: str) -> str:
    return f"fill:{order_id}"


async def _commit_fill(
    order: OrderState, trade: TradeState, new_cash: Decimal, new_lots: List[Lot],
) -> None:
    """Persist order, trade, position and account state in ONE transaction.

    Raises on any failure (including a duplicate fill key); nothing is partially
    written. Skipped only when no database was initialised (in-memory mode).
    """
    if not _db_ready():
        if _portfolio_starting or _portfolio_tasks or _recovery_blocked is not None:
            raise PortfolioRecoveryError("Durable portfolio database unavailable")
        return  # isolated in-process test compatibility only
    from backend.db.session import get_session
    from backend.db.models import (
        PaperAccountStateRecord, PaperOrderRecord, PositionRecord2, TradeRecord,
    )
    from sqlalchemy import select

    symbol, account_id = trade.symbol, trade.account_id
    realized_total = sum(
        (t.realized_pnl for t in _trades
         if t.symbol == symbol and t.realized_pnl is not None), Decimal("0"),
    ) + (trade.realized_pnl or Decimal("0"))
    qty = sum((l.qty for l in new_lots), Decimal("0"))
    avg = (sum((l.qty * l.entry_price for l in new_lots), Decimal("0")) / qty) if qty > 0 else Decimal("0")

    async with get_session() as session:
        async with session.begin():
            rec = await session.get(PaperOrderRecord, order.id)
            if rec:
                if (rec.status != "PENDING" or rec.account_id != account_id
                        or rec.symbol != order.symbol or rec.side != order.side):
                    raise PortfolioRecoveryError("Durable fill identity/status conflict")
                rec.status = "FILLED"
                rec.qty = float(order.qty)
                rec.updated_at = order.updated_at
            else:
                session.add(PaperOrderRecord(
                    id=order.id, account_id=order.account_id, symbol=order.symbol,
                    side=order.side, order_type=order.order_type, qty=float(order.qty),
                    price=float(order.price) if order.price else None,
                    status="FILLED", mode=order.mode,
                    created_at=order.created_at, updated_at=order.updated_at,
                ))
            session.add(TradeRecord(
                id=trade.id, order_id=trade.order_id, account_id=account_id,
                symbol=symbol, qty=float(trade.qty), price=float(trade.price),
                fee=float(trade.fee), side=trade.side,
                realized_pnl=float(trade.realized_pnl) if trade.realized_pnl is not None else None,
                executed_at=trade.executed_at, fill_key=_fill_key(trade.order_id),
                qty_text=str(trade.qty), price_text=str(trade.price), fee_text=str(trade.fee),
                realized_pnl_text=str(trade.realized_pnl), cash_after_text=str(new_cash),
            ))
            pos = (await session.execute(select(PositionRecord2).where(
                PositionRecord2.account_id == account_id, PositionRecord2.symbol == symbol,
            ))).scalar_one_or_none()
            if qty <= 0:
                if pos:
                    await session.delete(pos)
            elif pos:
                pos.qty, pos.avg_entry_price = float(qty), float(avg)
                pos.realized_pnl, pos.updated_at = float(realized_total), trade.executed_at
            else:
                session.add(PositionRecord2(
                    account_id=account_id, symbol=symbol, qty=float(qty),
                    avg_entry_price=float(avg), realized_pnl=float(realized_total),
                    unrealized_pnl=0.0, updated_at=trade.executed_at,
                ))
            state = await session.get(PaperAccountStateRecord, account_id)
            if state:
                state.cash_text, state.trade_counter = str(new_cash), trade.id
                state.updated_at = trade.executed_at
            else:
                session.add(PaperAccountStateRecord(
                    account_id=account_id, cash_text=str(new_cash),
                    peak_equity_text=str(_peak_equity), trade_counter=trade.id,
                    updated_at=trade.executed_at,
                ))


async def _record_peak(equity: Decimal, revision: int) -> None:
    """Publish a high-water mark only after durable evidence, never decrease it."""
    global _peak_equity, _recovery_blocked
    async with _peak_lock:
        if _recovery_blocked is not None or revision != _state_revision:
            raise PortfolioValuationUnavailable("Portfolio changed or requires recovery")
        if equity <= _peak_equity:
            return
        if not _db_ready():
            if _portfolio_tasks or _portfolio_starting:
                _recovery_blocked = "Durable peak persistence unavailable"
                raise PortfolioValuationUnavailable(_recovery_blocked)
            _peak_equity = equity  # isolated in-process compatibility
            return
        from backend.db.session import get_session
        from backend.db.models import PaperAccountStateRecord
        try:
            async with get_session() as session:
                async with session.begin():
                    state = await session.get(PaperAccountStateRecord, _DEFAULT_ACCOUNT_ID)
                    if state is None:
                        raise PortfolioRecoveryError("Missing durable account state")
                    stored = Decimal(state.peak_equity_text)
                    if not stored.is_finite() or stored <= 0:
                        raise PortfolioRecoveryError("Invalid durable peak")
                    peak = max(stored, _peak_equity, equity)
                    state.peak_equity_text = str(peak)
        except asyncio.CancelledError:
            _recovery_blocked = "Durable peak outcome requires reconciliation"
            raise
        except Exception as exc:
            _recovery_blocked = "Durable peak outcome requires reconciliation"
            raise PortfolioValuationUnavailable(_recovery_blocked) from exc
        _peak_equity = max(_peak_equity, peak)
        if revision != _state_revision or _recovery_blocked is not None:
            raise PortfolioValuationUnavailable("Portfolio changed or requires recovery")


async def _persist_snapshot(snap: EquitySnapshot) -> None:
    try:
        from backend.db.session import get_session
        from backend.db.models import EquitySnapshotRecord
        async with get_session() as session:
            session.add(EquitySnapshotRecord(
                account_id=snap.account_id, equity=snap.equity,
                cash=snap.cash, unrealized=snap.unrealized,
                drawdown_pct=snap.drawdown_pct, max_equity=snap.max_equity,
                timestamp=snap.timestamp,
            ))
            await session.commit()
    except Exception as exc:
        log.debug("snapshot persist error (non-fatal): %s", exc)


# ─────────────────────────────────────────────────────────────────
# Startup
# ─────────────────────────────────────────────────────────────────

async def start_portfolio_service(app) -> None:
    """Restore once and own the existing paper portfolio background loops."""
    global _portfolio_stop, _portfolio_starting
    if _portfolio_starting or any(not task.done() for task in _portfolio_tasks):
        return
    _portfolio_starting = True
    global _recovery_blocked
    try:
        try:
            await restore_portfolio_state()
            _recovery_blocked = None
        except Exception as exc:
            # Fail closed: no loops, no fills, no valuation from guessed state.
            _recovery_blocked = f"{type(exc).__name__}: {exc}"
            log.error("[portfolio] recovery blocked, paper trading disabled: %s", exc)
            raise
        _portfolio_stop = asyncio.Event()
        _portfolio_tasks.clear()
        _portfolio_tasks.update((
            asyncio.create_task(_snapshot_loop(), name="portfolio_snapshot"),
            asyncio.create_task(_limit_fill_loop(), name="portfolio_limit_fill"),
        ))
    finally:
        _portfolio_starting = False


async def stop_portfolio_service() -> None:
    """Drain existing loop work and queued writes before database disposal."""
    global _portfolio_stop
    if _portfolio_starting:
        raise RuntimeError("Portfolio startup is still in progress")
    if _portfolio_stop is not None:
        _portfolio_stop.set()
    timed_out = False
    if _portfolio_tasks:
        done, pending = await asyncio.wait(tuple(_portfolio_tasks), timeout=_SHUTDOWN_TIMEOUT)
        timed_out = bool(pending)
        for task in pending:
            task.cancel()
        results = await asyncio.gather(*_portfolio_tasks, return_exceptions=True)
        if any(isinstance(result, Exception) for result in results):
            log.warning("[portfolio] background loop failed during shutdown")
        _portfolio_tasks.clear()
    if _persistence_tasks:
        pending_writes = tuple(_persistence_tasks)
        _, pending = await asyncio.wait(pending_writes, timeout=_SHUTDOWN_TIMEOUT)
        timed_out = timed_out or bool(pending)
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending_writes, return_exceptions=True)
        _persistence_tasks.difference_update(pending_writes)
    _portfolio_stop = None
    if timed_out:
        raise RuntimeError("Portfolio shutdown timed out; persistence completeness unverified")


# ─────────────────────────────────────────────────────────────────
# Daily PnL aggregation
# ─────────────────────────────────────────────────────────────────

import datetime as _dt

_DEFAULT_DAILY_LOOKBACK = 30   # days returned by default


def _utc_date(ts: int) -> str:
    """Return 'YYYY-MM-DD' for a unix timestamp in UTC."""
    return _dt.datetime.utcfromtimestamp(ts).strftime("%Y-%m-%d")


def _today_utc() -> str:
    return _dt.datetime.utcnow().strftime("%Y-%m-%d")


async def get_daily_pnl(
    days: int = _DEFAULT_DAILY_LOOKBACK,
    account_id: str = _DEFAULT_ACCOUNT_ID,
) -> List[dict]:
    """
    Return daily PnL aggregates for the last `days` days.
    Builds from in-process trade history + live equity for today's unrealized.
    Falls back to DB equity snapshots when memory is empty.
    """
    from collections import defaultdict as _dd

    today = _today_utc()
    cutoff_ts = int(time.time()) - days * 86400

    # Aggregate realized trades by date
    by_date: dict = _dd(lambda: {
        "realized_pnl": 0.0, "unrealized_pnl": 0.0, "total_pnl": 0.0,
        "trade_count": 0, "win_count": 0, "loss_count": 0,
        "equity_open": None, "equity_close": None,
    })

    for trade in _trades:
        if trade.executed_at < cutoff_ts:
            continue
        date_key = _utc_date(trade.executed_at)
        row = by_date[date_key]
        if trade.realized_pnl is not None:
            pnl = float(trade.realized_pnl)
            row["realized_pnl"] += pnl
            if trade.side == "SELL":
                row["trade_count"] += 1
                if pnl > 0:
                    row["win_count"] += 1
                else:
                    row["loss_count"] += 1

    # Attach today's live unrealized
    _, _, unrealized, _ = await _marked_portfolio()
    by_date[today]["unrealized_pnl"] = float(unrealized)

    # Fill total_pnl and sort
    result = []
    for date_key in sorted(by_date.keys(), reverse=True)[:days]:
        row = dict(by_date[date_key])
        row["date_utc"] = date_key
        row["account_id"] = account_id
        row["total_pnl"] = row["realized_pnl"] + row["unrealized_pnl"]
        result.append(row)

    # Persist / upsert today's row best-effort
    if result:
        await _upsert_daily_pnl(result[0])

    return result


async def get_equity_history(
    hours: int = 24,
    account_id: str = _DEFAULT_ACCOUNT_ID,
) -> List[dict]:
    """
    Return equity snapshot time series from DB for the past `hours` hours.
    """
    try:
        from backend.db.session import get_session
        from backend.db.models import EquitySnapshotRecord
        from sqlalchemy import select

        cutoff = int(time.time()) - hours * 3600
        async with get_session() as session:
            rows = (await session.execute(
                select(EquitySnapshotRecord)
                .where(EquitySnapshotRecord.account_id == account_id)
                .where(EquitySnapshotRecord.timestamp >= cutoff)
                .order_by(EquitySnapshotRecord.timestamp.asc())
            )).scalars().all()
        return [
            {
                "timestamp":   r.timestamp,
                "equity":      r.equity,
                "cash":        r.cash,
                "unrealized":  r.unrealized,
                "drawdown_pct": r.drawdown_pct,
                "max_equity":  r.max_equity,
            }
            for r in rows
        ]
    except Exception as exc:
        log.debug("equity_history query error (non-fatal): %s", exc)
        return []


async def get_positions_detail() -> List[dict]:
    """
    Return open positions with full PnL breakdown (unrealized + realized).
    """
    if _recovery_blocked is not None:
        raise PortfolioValuationUnavailable("Portfolio recovery blocked")
    positions = []
    revision = _state_revision
    for symbol, lots in tuple(_lots.items()):
        if not lots:
            continue
        total_qty  = sum(l.qty for l in lots)
        total_cost = sum(l.qty * l.entry_price for l in lots)
        avg_entry  = total_cost / total_qty if total_qty else Decimal("0")

        try:
            mark = validated_mark(await get_price(symbol), symbol)
        except Exception as exc:
            raise PortfolioValuationUnavailable("Complete portfolio marks unavailable") from exc

        unrealized = (mark - avg_entry) * total_qty
        realized   = sum(
            t.realized_pnl for t in _trades
            if t.symbol == symbol and t.realized_pnl is not None
        ) or Decimal("0")
        notional   = mark * total_qty
        pnl_pct    = float(unrealized / (avg_entry * total_qty) * 100) \
                     if avg_entry * total_qty != 0 else 0.0

        positions.append({
            "symbol":           symbol,
            "qty":              float(total_qty),
            "avg_entry_price":  float(avg_entry.quantize(Decimal("0.01"))),
            "mark_price":       float(mark),
            "notional_value":   float(notional.quantize(Decimal("0.01"))),
            "unrealized_pnl":   float(unrealized.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)),
            "unrealized_pnl_pct": round(pnl_pct, 4),
            "realized_pnl":     float(realized.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)),
            "total_pnl":        float((unrealized + realized).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)),
            "lots":             len(lots),
            "oldest_lot_ts":    min(l.opened_at for l in lots),
        })

    if revision != _state_revision:
        raise PortfolioValuationUnavailable("Portfolio changed during valuation")
    return sorted(positions, key=lambda p: abs(p["notional_value"]), reverse=True)


async def _upsert_daily_pnl(row: dict) -> None:
    try:
        from backend.db.session import get_session
        from backend.db.models import DailyPnlRecord
        from sqlalchemy import select

        async with get_session() as session:
            existing = (await session.execute(
                select(DailyPnlRecord)
                .where(DailyPnlRecord.account_id == row["account_id"])
                .where(DailyPnlRecord.date_utc == row["date_utc"])
            )).scalar_one_or_none()

            if existing:
                existing.realized_pnl   = row["realized_pnl"]
                existing.unrealized_pnl = row["unrealized_pnl"]
                existing.total_pnl      = row["total_pnl"]
                existing.trade_count    = row["trade_count"]
                existing.win_count      = row["win_count"]
                existing.loss_count     = row["loss_count"]
            else:
                session.add(DailyPnlRecord(
                    account_id=row["account_id"],
                    date_utc=row["date_utc"],
                    realized_pnl=row["realized_pnl"],
                    unrealized_pnl=row["unrealized_pnl"],
                    total_pnl=row["total_pnl"],
                    trade_count=row["trade_count"],
                    win_count=row["win_count"],
                    loss_count=row["loss_count"],
                ))
            await session.commit()
    except Exception as exc:
        log.debug("daily_pnl upsert error (non-fatal): %s", exc)


# ─────────────────────────────────────────────────────────────────
# Force-close helpers (console layer)
# ─────────────────────────────────────────────────────────────────

async def close_position(symbol: str) -> Optional[dict]:
    """
    Force-close an open position for `symbol` by submitting a MARKET SELL
    for the full lot quantity.  Returns the resulting order dict, or None
    if there is no open position to close.
    """
    sym = symbol.upper()
    lots = _lots.get(sym, [])
    if not lots:
        return None

    total_qty = float(sum(l.qty for l in lots))
    order = await submit_order(
        symbol=sym, side="SELL", order_type="MARKET", qty=total_qty,
    )
    return {
        "order_id":   order.id,
        "symbol":     sym,
        "qty_closed": float(order.qty) if order.status == "FILLED" else 0.0,
        "status":     order.status,
        "created_at": order.created_at,
    }


async def close_all_positions() -> List[dict]:
    """
    Force-close every open position.  Returns a list of close results.
    """
    symbols_with_lots = [s for s, lots in _lots.items() if lots]
    results = []
    for sym in symbols_with_lots:
        result = await close_position(sym)
        if result:
            results.append(result)
    return results


async def cancel_pending_order(order_id: str) -> bool:
    """Acknowledge cancellation only after durable commit; serialize with fills."""
    global _recovery_blocked
    async with _fill_lock:
        order = _orders.get(order_id)
        if _recovery_blocked is not None:
            raise PortfolioRecoveryError("Portfolio recovery blocked")
        if not order or order.status != "PENDING":
            return False
        now = int(time.time())
        if _db_ready():
            from backend.db.session import get_session
            from backend.db.models import PaperOrderRecord
            from sqlalchemy import update
            try:
                async with get_session() as session:
                    async with session.begin():
                        result = await session.execute(update(PaperOrderRecord).where(
                            PaperOrderRecord.id == order.id,
                            PaperOrderRecord.account_id == order.account_id,
                            PaperOrderRecord.status == "PENDING",
                        ).values(status="CANCELLED", updated_at=now))
                        if result.rowcount != 1:
                            raise PortfolioRecoveryError("Pending order evidence disagrees with durable state")
            except asyncio.CancelledError:
                _recovery_blocked = "Cancellation outcome requires reconciliation"
                raise
            except Exception as exc:
                _recovery_blocked = "Cancellation outcome requires reconciliation"
                raise PortfolioRecoveryError(_recovery_blocked) from exc
        elif _portfolio_tasks or _portfolio_starting:
            _recovery_blocked = "Durable portfolio database unavailable"
            raise PortfolioRecoveryError(_recovery_blocked)
        order.status = "CANCELLED"
        order.updated_at = now
        return True


# ─────────────────────────────────────────────────────────────────
# DB state persistence — positions upsert + startup restore
# ─────────────────────────────────────────────────────────────────

def _replay_ledger(trade_rows, account_id: str):
    """Rebuild exact cash/lots/trades from durable fills; raise if incoherent."""
    cash, lots_by_sym, trades = STARTING_CASH, {}, []
    expected_id = 0
    for row in sorted(trade_rows, key=lambda r: r.id):
        expected_id += 1
        if row.id != expected_id:
            raise PortfolioRecoveryError(f"trade id gap before {row.id}")
        texts = (row.qty_text, row.price_text, row.fee_text, row.realized_pnl_text, row.cash_after_text)
        if row.fill_key != _fill_key(row.order_id or "") or any(t is None for t in texts):
            raise PortfolioRecoveryError(f"trade {row.id} lacks exact ledger evidence (legacy row)")
        try:
            qty, price, fee, realized, cash_after = (Decimal(t) for t in texts)
        except Exception as exc:
            raise PortfolioRecoveryError(f"trade {row.id} has malformed decimals") from exc
        if (row.side not in ("BUY", "SELL") or not all(v.is_finite() for v in (qty, price, fee, cash_after))
                or qty <= 0 or price <= 0 or fee < 0):
            raise PortfolioRecoveryError(f"trade {row.id} invalid")
        applied = _apply_fill(cash, lots_by_sym.get(row.symbol, []), row.side, row.symbol,
                              qty, price, fee, row.order_id, row.executed_at)
        if applied is None:
            raise PortfolioRecoveryError(f"trade {row.id} cannot be replayed (cash/inventory)")
        cash, lots_by_sym[row.symbol], replay_realized = applied
        if cash != cash_after or replay_realized != realized:
            raise PortfolioRecoveryError(f"trade {row.id} cash/realized disagree with replay")
        trades.append(TradeState(
            id=row.id, order_id=row.order_id, account_id=account_id, symbol=row.symbol,
            qty=qty, price=price, fee=fee, side=row.side, realized_pnl=realized,
            executed_at=row.executed_at,
        ))
    return cash, {s: l for s, l in lots_by_sym.items() if l}, trades


async def restore_portfolio_state(account_id: str = _DEFAULT_ACCOUNT_ID) -> None:
    """Restore exact FIFO lots, cash, peak and counter from coherent durable fills.

    Source of truth is the trades table replayed in id order; account state,
    positions and orders are cross-checked. Any disagreement or legacy/ambiguous
    row raises PortfolioRecoveryError and leaves in-memory state untouched.
    Fresh (empty) databases start from STARTING_CASH. Startup without an
    initialized durable database is blocked.
    """
    global _cash, _peak_equity, _trade_counter, _state_revision
    if not _db_ready():
        raise PortfolioRecoveryError("Durable portfolio database unavailable")

    from backend.db.session import get_session
    from backend.db.models import (
        EquitySnapshotRecord, PaperAccountStateRecord, PaperOrderRecord,
        PositionRecord2, TradeRecord,
    )
    from sqlalchemy import select

    async with get_session() as session:
        trade_rows = (await session.execute(
            select(TradeRecord).where(TradeRecord.account_id == account_id))).scalars().all()
        state = await session.get(PaperAccountStateRecord, account_id)
        positions = (await session.execute(select(PositionRecord2).where(
            PositionRecord2.account_id == account_id, PositionRecord2.qty > 0))).scalars().all()
        orders = (await session.execute(
            select(PaperOrderRecord).where(PaperOrderRecord.account_id == account_id))).scalars().all()
        snaps = (await session.execute(select(EquitySnapshotRecord).where(
            EquitySnapshotRecord.account_id == account_id))).scalars().all()

    cash, lots, trades = _replay_ledger(trade_rows, account_id)
    counter = trades[-1].id if trades else 0
    peak = STARTING_CASH
    if trades or state is not None:
        if state is None:
            raise PortfolioRecoveryError("trades exist without paper account state")
        try:
            state_cash, state_peak = Decimal(state.cash_text), Decimal(state.peak_equity_text)
        except Exception as exc:
            raise PortfolioRecoveryError("malformed paper account state") from exc
        if state_cash != cash or state.trade_counter != counter or not state_peak.is_finite() or state_peak <= 0:
            raise PortfolioRecoveryError("paper account state disagrees with trade replay")
        peak = state_peak
    elif snaps:
        latest = max(snaps, key=lambda s: s.timestamp or 0)
        if Decimal(str(latest.cash)) != STARTING_CASH:
            raise PortfolioRecoveryError("snapshot cash without fill evidence")
    for s in snaps:
        peak = max(peak, Decimal(str(s.max_equity)))

    # Positions table must match the replayed inventory exactly (by symbol/qty).
    stored = {p.symbol: p for p in positions}
    if set(stored) != set(lots):
        raise PortfolioRecoveryError("paper_positions symbols disagree with replay")
    for sym, p in stored.items():
        total = sum((l.qty for l in lots[sym]), Decimal("0"))
        if abs(Decimal(str(p.qty)) - total) > Decimal("1e-6") * max(Decimal(1), total):
            raise PortfolioRecoveryError(f"paper_positions qty for {sym} disagrees with replay")

    # Orders: FILLED orders and trades must pair one-to-one; keep PENDING limits.
    filled_ids = {o.id for o in orders if o.status == "FILLED"}
    if filled_ids != {t.order_id for t in trades}:
        raise PortfolioRecoveryError("filled orders and trades disagree")
    restored_orders: Dict[str, OrderState] = {}
    for o in orders:
        if o.status not in ("PENDING", "FILLED", "CANCELLED"):
            raise PortfolioRecoveryError(f"order {o.id} has an unresolved durable status")
        if o.status == "PENDING":
            try:
                qty = _qty(o.qty)
                price = _qty(o.price)
                valid = (qty.is_finite() and qty > 0 and price.is_finite() and price > 0)
            except (ArithmeticError, TypeError, ValueError):
                valid = False
            if (o.order_type != "LIMIT" or o.side not in ("BUY", "SELL")
                    or o.mode != "paper" or not valid):
                raise PortfolioRecoveryError(f"pending order {o.id} is malformed")
        restored_orders[o.id] = OrderState(
            id=o.id, account_id=o.account_id, symbol=o.symbol, side=o.side,
            order_type=o.order_type, qty=_qty(o.qty), price=_qty(o.price) if o.price is not None else None, status=o.status,
            mode=o.mode or "paper", created_at=o.created_at or 0, updated_at=o.updated_at or 0,
        )

    # Publish only after every check passed.
    _state_revision += 1
    _cash, _peak_equity, _trade_counter = cash, peak, counter
    _lots.clear()
    for sym, l in lots.items():
        _lots[sym] = l
    _trades[:] = trades
    _orders.clear()
    _orders.update(restored_orders)
    log.info("[portfolio] restored %d trades, %d positions, %d orders",
             len(trades), len(lots), len(restored_orders))
