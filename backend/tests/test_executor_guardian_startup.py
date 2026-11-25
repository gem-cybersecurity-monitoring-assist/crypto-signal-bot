from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from backend.services.guardian_bot import service as guardian
from backend.services.signal_executor import service as executor


@pytest.mark.asyncio
async def test_startup_preserves_guardian(monkeypatch):
    monkeypatch.setattr(executor, "_nav_anchored", False)
    monkeypatch.setattr(executor, "_startup_observed", False)
    monkeypatch.setattr(guardian, "_kill_switch_active", True)
    monkeypatch.setattr(guardian, "_drawdown_pct", 21.0)
    reset = AsyncMock()
    monkeypatch.setattr(guardian, "reset_kill_switch", reset, raising=False)
    await executor._anchor_nav_on_start()
    assert guardian._kill_switch_active is True
    assert guardian._drawdown_pct == 21.0
    reset.assert_not_awaited()
    assert executor.get_executor_status()["startup_observed"] is True
    assert executor.get_executor_status()["nav_anchored"] is False


@pytest.mark.asyncio
@pytest.mark.parametrize("case", ["halt", "trigger", "heartbeat", "drift", "cooldown", "redis_halt", "exception"])
async def test_sweep_stops_on_unclear_guardian(monkeypatch, case):
    status = dict(kill_switch_active=False, triggered=False, heartbeat_healthy=True,
                  reconciliation_drift_active=False, in_cooldown=False)
    if case == "halt":
        status["kill_switch_active"] = True
    elif case == "trigger":
        status["triggered"] = True
    elif case == "heartbeat":
        status["heartbeat_healthy"] = False
    elif case == "drift":
        status["reconciliation_drift_active"] = True
    elif case == "cooldown":
        status["in_cooldown"] = True
    reader = AsyncMock(return_value=SimpleNamespace(**status))
    if case == "exception":
        reader.side_effect = RuntimeError("unavailable")
    monkeypatch.setattr(guardian, "get_guardian_status", reader)
    monkeypatch.setattr(guardian, "is_kill_switch_active", AsyncMock(return_value=case == "redis_halt"))
    monkeypatch.setattr(executor, "_startup_observed", True)
    equity = AsyncMock()
    order = AsyncMock()
    monkeypatch.setattr(executor, "_get_equity", equity)
    monkeypatch.setattr(executor, "submit_order", order)
    await executor._executor_sweep()
    equity.assert_not_awaited()
    order.assert_not_awaited()
