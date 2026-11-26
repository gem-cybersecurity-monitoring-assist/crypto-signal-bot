"""SQLite-backed tests: atomic paper fills, exact restart recovery, fail-closed."""
import time
from decimal import Decimal
from types import SimpleNamespace

import pytest
import sqlalchemy as sa
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from backend.db import session as db_session
from backend.db.models import (
    Base, PaperAccountStateRecord, PaperOrderRecord, PositionRecord2, TradeRecord,
)
from backend.db.paper_ledger_schema import upgrade_paper_ledger_schema
from backend.services.portfolio import service as svc

PRICE = {"v": "100"}


@pytest.fixture
async def db(tmp_path, monkeypatch):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path/'p.db'}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    monkeypatch.setattr(db_session, "_engine", engine)
    monkeypatch.setattr(db_session, "_session_factory",
                        async_sessionmaker(engine, expire_on_commit=False))

    async def get_price(symbol):
        return SimpleNamespace(price=PRICE["v"], stale=False, market_data_mode="live",
                               symbol=symbol, source="test", fetched_at=int(time.time()))

    async def approve(**_):
        return SimpleNamespace(approved=True, kill_switch=False, size_multiplier=1)

    monkeypatch.setattr(svc, "get_price", get_price)
    monkeypatch.setattr(svc, "_evaluate_order", approve)
    svc.reset_portfolio()
    PRICE["v"] = "100"
    yield engine
    svc.reset_portfolio()
    await engine.dispose()


async def _rows(model):
    async with db_session.get_session() as s:
        return (await s.execute(sa.select(model))).scalars().all()


def _snapshot():
    return (svc._cash, {k: [(l.qty, l.entry_price) for l in v] for k, v in svc._lots.items() if v},
            [(t.id, t.order_id, t.realized_pnl) for t in svc._trades], svc._trade_counter,
            svc._peak_equity)


async def _trade_sequence():
    await svc.submit_order("BTCUSDT", "BUY", "MARKET", 1)
    PRICE["v"] = "110"
    await svc.submit_order("BTCUSDT", "BUY", "MARKET", 2)
    PRICE["v"] = "120"
    await svc.submit_order("BTCUSDT", "SELL", "MARKET", 1.5)  # FIFO: lot1 + half lot2


@pytest.mark.asyncio
async def test_restart_recovers_exact_state(db):
    await _trade_sequence()
    before = _snapshot()
    assert before[3] == 3 and before[4] >= svc.STARTING_CASH
    assert len(await _rows(PaperAccountStateRecord)) == 1
    svc.reset_portfolio()
    await svc.restore_portfolio_state()
    assert _snapshot() == before
    # FIFO continuity after restart: remaining lot is 1.5 @ 110 exactly
    assert svc._lots["BTCUSDT"][0].qty == Decimal("1.5")
    assert svc._lots["BTCUSDT"][0].entry_price == Decimal("110")


@pytest.mark.asyncio
async def test_duplicate_fill_identity_rejected(db):
    order = await svc.submit_order("BTCUSDT", "BUY", "MARKET", 1)
    snap = _snapshot()
    dup = svc.OrderState(id=order.id, account_id="paper-default", symbol="BTCUSDT",
                         side="BUY", order_type="MARKET", qty=Decimal(1), price=None,
                         status="PENDING")
    await svc._fill_order(dup)
    assert dup.status == "CANCELLED" and _snapshot() == snap
    assert len(await _rows(TradeRecord)) == 1
    # DB-level: unique fill key rejects a second row
    async with db_session.get_session() as s:
        s.add(TradeRecord(id=99, order_id=order.id, account_id="paper-default", symbol="X",
                          qty=1, price=1, side="BUY", fill_key=f"fill:{order.id}"))
        with pytest.raises(sa.exc.IntegrityError):
            await s.commit()


@pytest.mark.asyncio
async def test_failed_commit_rolls_back_everything(db):
    await svc.submit_order("BTCUSDT", "BUY", "MARKET", 1)
    snap = _snapshot()
    orders_before = len(await _rows(PaperOrderRecord))
    # Pre-existing conflicting fill key makes the trade insert fail mid-transaction.
    async with db_session.get_session() as s:
        s.add(TradeRecord(id=500, order_id="o-x", account_id="paper-default", symbol="Z",
                          qty=1, price=1, side="BUY", fill_key="fill:fixed"))
        await s.commit()
    order = svc.OrderState(id="fixed", account_id="paper-default", symbol="BTCUSDT",
                           side="BUY", order_type="MARKET", qty=Decimal(1), price=None,
                           status="PENDING")
    await svc._fill_order(order)
    assert order.status == "CANCELLED"
    assert _snapshot() == snap
    assert len(await _rows(PaperOrderRecord)) == orders_before  # order row rolled back
    assert len(await _rows(TradeRecord)) == 2
    state = (await _rows(PaperAccountStateRecord))[0]
    assert state.trade_counter == 1 and Decimal(state.cash_text) == snap[0]
    assert float((await _rows(PositionRecord2))[0].qty) == 1.0


@pytest.mark.asyncio
async def test_legacy_trade_rows_block_recovery(db):
    async with db_session.get_session() as s:
        s.add(TradeRecord(order_id="old", account_id="paper-default", symbol="BTCUSDT",
                          qty=1, price=100, fee=0.1, side="BUY", executed_at=1))
        await s.commit()
    with pytest.raises(svc.PortfolioRecoveryError):
        await svc.restore_portfolio_state()
    assert svc._cash == svc.STARTING_CASH and not svc._trades  # untouched
    with pytest.raises(svc.PortfolioRecoveryError):
        await svc.start_portfolio_service(None)
    assert svc._recovery_blocked and not svc._portfolio_tasks
    order = await svc.submit_order("BTCUSDT", "BUY", "MARKET", 1)
    assert order.status == "CANCELLED" and not svc._trades
    with pytest.raises(svc.PortfolioValuationUnavailable):
        await svc.get_portfolio_summary()


@pytest.mark.asyncio
async def test_state_disagreeing_with_replay_blocks(db):
    await _trade_sequence()
    async with db_session.get_session() as s:
        state = (await s.execute(sa.select(PaperAccountStateRecord))).scalar_one()
        state.cash_text = "1"
        await s.commit()
    svc.reset_portfolio()
    with pytest.raises(svc.PortfolioRecoveryError):
        await svc.restore_portfolio_state()


@pytest.mark.asyncio
async def test_positions_table_disagreement_blocks(db):
    await svc.submit_order("BTCUSDT", "BUY", "MARKET", 1)
    async with db_session.get_session() as s:
        pos = (await s.execute(sa.select(PositionRecord2))).scalar_one()
        pos.qty = 5.0
        await s.commit()
    svc.reset_portfolio()
    with pytest.raises(svc.PortfolioRecoveryError):
        await svc.restore_portfolio_state()


@pytest.mark.asyncio
async def test_empty_database_starts_fresh(db):
    await svc.restore_portfolio_state()
    assert svc._cash == svc.STARTING_CASH and svc._trade_counter == 0 and not svc._lots


@pytest.mark.asyncio
async def test_pending_limit_order_restored(db):
    order = await svc.submit_order("BTCUSDT", "BUY", "LIMIT", 1, price=50)
    assert order.status == "PENDING"
    svc.reset_portfolio()
    await svc.restore_portfolio_state()
    assert svc._orders[order.id].status == "PENDING"


@pytest.mark.asyncio
async def test_schema_upgrade_adds_columns_idempotently(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path/'old.db'}")
    async with engine.begin() as conn:
        await conn.execute(sa.text(
            "CREATE TABLE trades (id INTEGER PRIMARY KEY, order_id VARCHAR(64) NOT NULL, "
            "account_id VARCHAR(64) NOT NULL, symbol VARCHAR(20) NOT NULL, qty FLOAT, "
            "price FLOAT, fee FLOAT, side VARCHAR(8), realized_pnl FLOAT, executed_at BIGINT)"))
        await conn.execute(sa.text(
            "INSERT INTO trades (order_id, account_id, symbol, qty, price, fee, side) "
            "VALUES ('o','a','S',1,1,0,'BUY')"))
        await conn.run_sync(upgrade_paper_ledger_schema)
        await conn.run_sync(upgrade_paper_ledger_schema)
        cols = await conn.run_sync(lambda c: {x["name"] for x in sa.inspect(c).get_columns("trades")})
        idx = await conn.run_sync(lambda c: {x["name"] for x in sa.inspect(c).get_indexes("trades")})
        rows = (await conn.execute(sa.text("SELECT fill_key FROM trades"))).all()
    assert {"fill_key", "cash_after_text", "qty_text"} <= cols
    assert "ux_trades_account_fill_key" in idx
    assert rows == [(None,)]  # legacy evidence stays NULL (ambiguous, not invented)
    await engine.dispose()


@pytest.mark.asyncio
async def test_durable_reset_routes_preserve_ledger_and_guardian(db, monkeypatch):
    from fastapi import HTTPException
    from unittest.mock import AsyncMock
    from backend.routes.console_v1 import console_portfolio_reset, PortfolioResetRequest as ConsoleReset
    from backend.routes.risk_v1 import paper_reset, PaperResetRequest as RiskReset
    from backend.services.guardian_bot import service as guardian
    await svc.submit_order("BTCUSDT", "BUY", "MARKET", 1)
    before = _snapshot()
    deactivate = AsyncMock()
    monkeypatch.setattr(guardian, "deactivate_kill_switch", deactivate)
    for action, body in [(console_portfolio_reset, ConsoleReset(confirm=True, starting_cash=10000)),
                         (paper_reset, RiskReset(starting_cash=10000))]:
        with pytest.raises(HTTPException) as exc:
            await action(body)
        assert exc.value.status_code == 409
    assert _snapshot() == before and len(await _rows(TradeRecord)) == 1
    deactivate.assert_not_awaited()


@pytest.mark.asyncio
async def test_startup_without_durable_database_latches_recovery(monkeypatch):
    monkeypatch.setattr(db_session, "_session_factory", None)
    monkeypatch.setattr(svc, "_recovery_blocked", None)
    with pytest.raises(svc.PortfolioRecoveryError, match="database unavailable"):
        await svc.start_portfolio_service(None)
    assert svc._recovery_blocked is not None
    with pytest.raises(svc.PortfolioValuationUnavailable):
        await svc.get_positions_detail()


@pytest.mark.asyncio
async def test_unknown_commit_outcome_cannot_be_overwritten(db, monkeypatch):
    original = svc._commit_fill
    async def committed_then_disconnected(*args):
        await original(*args)
        raise TimeoutError("simulated lost commit response")
    monkeypatch.setattr(svc, "_commit_fill", committed_then_disconnected)
    order = await svc.submit_order("BTCUSDT", "BUY", "MARKET", 1)
    assert svc._recovery_blocked is not None
    assert len(await _rows(TradeRecord)) == 1
    durable = (await _rows(PaperOrderRecord))[0]
    assert durable.status == "FILLED"
    assert order.status == "FILLING"
    with pytest.raises(svc.PortfolioValuationUnavailable):
        await svc.get_portfolio_summary()
    await svc.restore_portfolio_state()
    assert len(svc._trades) == 1
    assert svc._cash == Decimal("9899.9")
