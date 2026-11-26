"""
Tests for Portfolio & PnL engine.
Uses unittest.mock to avoid live price calls.
"""
from __future__ import annotations

import asyncio
import time
from decimal import Decimal
from unittest.mock import AsyncMock, patch

import pytest

import backend.services.portfolio.service as svc
from backend.services.portfolio.service import (
    STARTING_CASH,
    reset_portfolio,
    get_portfolio_summary,
    get_orders,
    get_trades,
    submit_order,
    _compute_equity,
    _fifo_close,
    _cash, _lots, _orders, _trades,
)

# ── helpers ───────────────────────────────────────────────────────

def _mock_price(value: float):
    """Patch get_price to return a fake snapshot."""
    snap = AsyncMock()
    snap.price = Decimal(str(value))
    snap.stale = False
    snap.market_data_mode = "paper_live"
    snap.source = "fixture"
    snap.fetched_at = int(time.time())
    async def by_symbol(symbol):
        snap.symbol = symbol
        return snap
    return AsyncMock(side_effect=by_symbol)


def run(coro):
    try:
        loop = asyncio.get_event_loop()
        if loop.is_running():
            # Inside pytest-asyncio — use a new loop
            import concurrent.futures
            with concurrent.futures.ThreadPoolExecutor(1) as pool:
                future = pool.submit(asyncio.run, coro)
                return future.result()
        return loop.run_until_complete(coro)
    except RuntimeError:
        return asyncio.run(coro)


# ── fixtures ──────────────────────────────────────────────────────

@pytest.fixture(autouse=True)
def fresh_portfolio():
    """Reset in-process state and bypass risk gate for portfolio unit tests."""
    reset_portfolio(STARTING_CASH)
    # Bypass risk gate so portfolio tests focus on portfolio mechanics only
    from backend.services.risk_gate.service import RiskGateDecision
    # Return approved with size_multiplier=1.0 so portfolio uses original qty
    approved_decision = RiskGateDecision(
        approved=True, order_qty=0.0, original_qty=0.0,
        size_multiplier=1.0, kill_switch=False,
        rules_passed=["all"], rules_failed=[],
        reasons=["test bypass"], risk_score=0.0,
    )
    from unittest.mock import AsyncMock, patch as _patch
    with _patch("backend.services.portfolio.service._evaluate_order",
                AsyncMock(return_value=approved_decision)):
        yield
    reset_portfolio(STARTING_CASH)


# ── MARKET BUY ────────────────────────────────────────────────────

class TestMarketBuy:
    def test_order_status_filled(self):
        with patch("backend.services.portfolio.service.get_price", _mock_price(50000)):
            order = run(submit_order("BTCUSDT", "BUY", "MARKET", 0.1))
        assert order.status == "FILLED"

    def test_cash_deducted(self):
        price = 50000.0
        qty   = 0.1
        with patch("backend.services.portfolio.service.get_price", _mock_price(price)):
            run(submit_order("BTCUSDT", "BUY", "MARKET", qty))
        cost      = Decimal(str(price)) * Decimal(str(qty))
        fee       = cost * svc.FEE_RATE
        expected  = STARTING_CASH - cost - fee
        assert abs(svc._cash - expected) < Decimal("0.01")

    def test_lot_created(self):
        with patch("backend.services.portfolio.service.get_price", _mock_price(50000)):
            run(submit_order("BTCUSDT", "BUY", "MARKET", 0.1))
        assert len(svc._lots["BTCUSDT"]) == 1
        assert svc._lots["BTCUSDT"][0].qty == Decimal("0.1")

    def test_insufficient_cash_cancels(self):
        # Try to buy 1 BTC at 50000 but we only have 10000 starting cash
        with patch("backend.services.portfolio.service.get_price", _mock_price(50000)):
            order = run(submit_order("BTCUSDT", "BUY", "MARKET", 1.0))
        assert order.status == "CANCELLED"
        assert svc._cash == STARTING_CASH    # cash unchanged


# ── MARKET SELL ───────────────────────────────────────────────────

class TestMarketSell:
    def test_sell_fills_and_closes_position(self):
        with patch("backend.services.portfolio.service.get_price", _mock_price(50000)):
            run(submit_order("BTCUSDT", "BUY", "MARKET", 0.1))
        with patch("backend.services.portfolio.service.get_price", _mock_price(52000)):
            run(submit_order("BTCUSDT", "SELL", "MARKET", 0.1))
        assert len(svc._lots.get("BTCUSDT", [])) == 0

    def test_profitable_sell_increases_cash(self):
        with patch("backend.services.portfolio.service.get_price", _mock_price(50000)):
            run(submit_order("BTCUSDT", "BUY", "MARKET", 0.1))
        cash_after_buy = svc._cash
        with patch("backend.services.portfolio.service.get_price", _mock_price(55000)):
            run(submit_order("BTCUSDT", "SELL", "MARKET", 0.1))
        assert svc._cash > cash_after_buy

    def test_realized_pnl_positive_on_profit(self):
        with patch("backend.services.portfolio.service.get_price", _mock_price(40000)):
            run(submit_order("BTCUSDT", "BUY", "MARKET", 0.1))
        with patch("backend.services.portfolio.service.get_price", _mock_price(45000)):
            run(submit_order("BTCUSDT", "SELL", "MARKET", 0.1))
        sell_trade = [t for t in svc._trades if t.side == "SELL"][-1]
        assert sell_trade.realized_pnl > 0

    def test_realized_pnl_negative_on_loss(self):
        with patch("backend.services.portfolio.service.get_price", _mock_price(50000)):
            run(submit_order("BTCUSDT", "BUY", "MARKET", 0.1))
        with patch("backend.services.portfolio.service.get_price", _mock_price(45000)):
            run(submit_order("BTCUSDT", "SELL", "MARKET", 0.1))
        sell_trade = [t for t in svc._trades if t.side == "SELL"][-1]
        assert sell_trade.realized_pnl < 0

    def test_sell_without_position_cancels(self):
        with patch("backend.services.portfolio.service.get_price", _mock_price(50000)):
            order = run(submit_order("BTCUSDT", "SELL", "MARKET", 0.1))
        assert order.status == "CANCELLED"


# ── LIMIT ORDER ───────────────────────────────────────────────────

class TestLimitOrder:
    def test_limit_buy_stays_pending(self):
        with patch("backend.services.portfolio.service.get_price", _mock_price(50000)):
            order = run(submit_order("BTCUSDT", "BUY", "LIMIT", 0.1, price=45000))
        assert order.status == "PENDING"

    def test_limit_order_stored(self):
        with patch("backend.services.portfolio.service.get_price", _mock_price(50000)):
            order = run(submit_order("BTCUSDT", "BUY", "LIMIT", 0.1, price=45000))
        assert order.id in svc._orders
        assert svc._orders[order.id].order_type == "LIMIT"


# ── FIFO ──────────────────────────────────────────────────────────

class TestFIFO:
    def test_fifo_single_lot(self):
        with patch("backend.services.portfolio.service.get_price", _mock_price(100)):
            run(submit_order("ETHUSD", "BUY", "MARKET", 1.0))
        avg_cost, pnl = _fifo_close("ETHUSD", Decimal("1.0"), Decimal("120"))
        assert avg_cost == pytest.approx(Decimal("100"), abs=Decimal("1"))
        assert pnl == pytest.approx(Decimal("20"), abs=Decimal("1"))

    def test_fifo_partial_lot(self):
        with patch("backend.services.portfolio.service.get_price", _mock_price(100)):
            run(submit_order("ETHUSD", "BUY", "MARKET", 2.0))
        _fifo_close("ETHUSD", Decimal("1.0"), Decimal("110"))
        # 1 lot should remain
        assert sum(l.qty for l in svc._lots["ETHUSD"]) == pytest.approx(1.0, abs=0.001)

    def test_fifo_multi_lot_order(self):
        with patch("backend.services.portfolio.service.get_price", _mock_price(100)):
            run(submit_order("ETHUSD", "BUY", "MARKET", 1.0))
        with patch("backend.services.portfolio.service.get_price", _mock_price(200)):
            run(submit_order("ETHUSD", "BUY", "MARKET", 1.0))
        # Selling 1 unit should consume first lot at cost=100
        avg_cost, _ = _fifo_close("ETHUSD", Decimal("1.0"), Decimal("150"))
        assert avg_cost == pytest.approx(Decimal("100"), abs=Decimal("2"))


# ── Equity & Drawdown ─────────────────────────────────────────────

class TestEquity:
    def test_equity_equals_cash_when_no_positions(self):
        async def _check():
            eq = await _compute_equity()
            return eq
        eq = run(_check())
        assert eq == pytest.approx(STARTING_CASH, abs=Decimal("0.01"))

    def test_equity_increases_on_mark_up(self):
        # Buy at 100, mark moves to 200 — unrealized gain should exceed fee paid
        with patch("backend.services.portfolio.service.get_price", _mock_price(100)):
            run(submit_order("ETHUSD", "BUY", "MARKET", 1.0))
        cash_after_buy = float(svc._cash)

        async def _check():
            with patch("backend.services.portfolio.service.get_price", _mock_price(200)):
                return await _compute_equity()

        eq = run(_check())
        # equity should be cash + unrealized_gain = cash_after_buy + (200-100)*1
        assert float(eq) > cash_after_buy + 90    # 100 gain minus small fee

    def test_drawdown_calculated(self):
        async def _check():
            with patch("backend.services.portfolio.service.get_price", _mock_price(10000)):
                summary = await get_portfolio_summary()
            return summary
        summary = run(_check())
        assert "drawdown_pct" in summary
        assert summary["drawdown_pct"] >= 0


# ── Portfolio summary ─────────────────────────────────────────────

class TestPortfolioSummary:
    def test_summary_has_required_fields(self):
        async def _check():
            with patch("backend.services.portfolio.service.get_price", _mock_price(50000)):
                return await get_portfolio_summary()
        s = run(_check())
        for k in ["cash_balance", "equity", "max_equity", "drawdown_pct",
                   "total_realized_pnl", "total_unrealized_pnl",
                   "trade_count", "win_rate_pct", "open_positions"]:
            assert k in s

    def test_win_rate_100_on_all_wins(self):
        with patch("backend.services.portfolio.service.get_price", _mock_price(100)):
            run(submit_order("ETHUSD", "BUY", "MARKET", 1.0))
        with patch("backend.services.portfolio.service.get_price", _mock_price(200)):
            run(submit_order("ETHUSD", "SELL", "MARKET", 1.0))

        async def _check():
            with patch("backend.services.portfolio.service.get_price", _mock_price(200)):
                return await get_portfolio_summary()
        s = run(_check())
        assert s["win_rate_pct"] == 100.0

    def test_trade_count_increments(self):
        with patch("backend.services.portfolio.service.get_price", _mock_price(100)):
            run(submit_order("ETHUSD", "BUY", "MARKET", 1.0))
        with patch("backend.services.portfolio.service.get_price", _mock_price(110)):
            run(submit_order("ETHUSD", "SELL", "MARKET", 1.0))

        async def _check():
            with patch("backend.services.portfolio.service.get_price", _mock_price(110)):
                return await get_portfolio_summary()
        s = run(_check())
        assert s["trade_count"] == 1   # 1 SELL = 1 closed trade


class TestPortfolioSafetyAndValuation:
    def test_risk_exception_never_creates_fill(self):
        with patch.object(svc, "get_price", _mock_price(100)), patch.object(
            svc, "_evaluate_order", AsyncMock(side_effect=RuntimeError("risk unavailable"))
        ):
            order = run(submit_order("ETHUSD", "BUY", "MARKET", 1))
        assert order.status == "CANCELLED"
        assert not svc._trades
        assert svc._cash == STARTING_CASH

    @pytest.mark.parametrize("mode", ["stale", "cache", "wrong_symbol", "expired"])
    def test_invalid_snapshot_never_creates_fill(self, mode):
        async def bad(symbol):
            snap = await _mock_price(100)(symbol)
            if mode == "stale":
                snap.stale = True
            elif mode == "cache":
                snap.source = "cache:1s_old"
            elif mode == "wrong_symbol":
                snap.symbol = "OTHER"
            else:
                snap.fetched_at -= 61
            return snap
        with patch.object(svc, "get_price", bad):
            order = run(submit_order("ETHUSD", "BUY", "MARKET", 1))
        assert order.status == "CANCELLED"
        assert not svc._trades

    def test_exact_equity_and_unrealized_pnl_use_same_observation(self):
        with patch.object(svc, "get_price", _mock_price(100)):
            run(submit_order("ETHUSD", "BUY", "MARKET", 2))
        with patch.object(svc, "get_price", _mock_price(120)) as price:
            summary = run(get_portfolio_summary())
        assert summary["cash_balance"] == 9799.8
        assert summary["equity"] == 10039.8
        assert summary["total_unrealized_pnl"] == 40
        assert summary["total_realized_pnl"] == -0.2
        assert summary["drawdown_pct"] == 0
        assert price.await_count == 1

    def test_partial_sale_records_actual_qty_and_fee(self):
        with patch.object(svc, "get_price", _mock_price(100)):
            run(submit_order("ETHUSD", "BUY", "MARKET", 1))
        with patch.object(svc, "get_price", _mock_price(120)):
            order = run(submit_order("ETHUSD", "SELL", "MARKET", 2))
            summary = run(get_portfolio_summary())
        assert order.qty == Decimal("1")
        assert svc._trades[-1].qty == Decimal("1")
        assert svc._trades[-1].fee == Decimal("0.12")
        assert summary["cash_balance"] == 10019.78
        assert summary["total_realized_pnl"] == 19.78

    def test_missing_mark_is_unavailable_not_zero_inventory(self):
        with patch.object(svc, "get_price", _mock_price(100)):
            run(submit_order("ETHUSD", "BUY", "MARKET", 1))
        with patch.object(svc, "get_price", AsyncMock(side_effect=RuntimeError("offline"))):
            with pytest.raises(svc.PortfolioValuationUnavailable):
                asyncio.run(get_portfolio_summary())

    def test_limit_is_rechecked_at_actual_fill_price_and_risk(self):
        with patch.object(svc, "get_price", _mock_price(110)):
            order = run(submit_order("ETHUSD", "BUY", "LIMIT", 1, price=100))
            run(svc._fill_order(order))
        assert order.status == "PENDING"
        with patch.object(svc, "get_price", _mock_price(99)), patch.object(
            svc, "_evaluate_order", AsyncMock(side_effect=RuntimeError("risk unavailable"))
        ):
            run(svc._fill_order(order))
        assert order.status == "CANCELLED"
        assert not svc._trades

    def test_cancel_during_risk_check_cannot_fill(self):
        async def risk(**kwargs):
            order = next(iter(svc._orders.values()))
            order.status = "CANCELLED"
            from backend.services.risk_gate.service import RiskGateDecision
            return RiskGateDecision(True, 1, 1, 1, False, [], [], [], 0)
        with patch.object(svc, "get_price", _mock_price(100)), patch.object(svc, "_evaluate_order", risk):
            order = run(submit_order("ETHUSD", "BUY", "MARKET", 1))
        assert order.status == "CANCELLED"
        assert not svc._trades

    def test_already_filled_order_cannot_fill_again(self):
        with patch.object(svc, "get_price", _mock_price(100)):
            order = run(submit_order("ETHUSD", "BUY", "MARKET", 1))
            run(svc._fill_order(order))
        assert len(svc._trades) == 1
        assert svc._cash == Decimal("9899.9")
