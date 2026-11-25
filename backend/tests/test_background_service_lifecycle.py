"""Verify ownership and cancellation without starting network/provider work."""
import asyncio
from unittest.mock import AsyncMock

import pytest

from backend.services.guardian_bot import monitor
from backend.services.monitoring import service as health
from backend.services.reconciliation import service as reconcile
from backend.services.surge_scanner import service as surge

CASES = [
    (monitor, "_monitor_task", "_monitor_loop", "start_guardian_monitor", "stop_guardian_monitor", None, (None,)),
    (health, "_monitor_task", "_monitor_loop", "start_monitoring_service", "stop_monitoring_service", "_running", (None,)),
    (reconcile, "_loop_task", "_reconciliation_loop", "start_reconciliation", "stop_reconciliation", "_loop_running", ()),
    (surge, "_scanner_task", "_scanner_loop", "start_surge_scanner", "stop_surge_scanner", "_running", ()),
]


@pytest.mark.asyncio
@pytest.mark.parametrize("module,task_attr,loop_attr,start_name,stop_name,flag,args", CASES)
async def test_duplicate_start_and_joined_shutdown(monkeypatch, module, task_attr, loop_attr, start_name, stop_name, flag, args):
    monkeypatch.setattr(module, task_attr, None)
    if flag:
        monkeypatch.setattr(module, flag, False)
    entered = asyncio.Event()
    exited = asyncio.Event()

    async def loop():
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            exited.set()

    mock = AsyncMock(side_effect=loop)
    monkeypatch.setattr(module, loop_attr, mock)
    start = getattr(module, start_name)
    stop = getattr(module, stop_name)
    try:
        await start(*args)
        task = getattr(module, task_attr)
        await start(*args)
        assert getattr(module, task_attr) is task
        await asyncio.wait_for(entered.wait(), timeout=1)
        mock.assert_awaited_once()
        await stop()
        assert exited.is_set()
        assert task.cancelled()
        assert getattr(module, task_attr) is None
        if flag:
            assert getattr(module, flag) is False
        await stop()
        await start(*args)
        assert getattr(module, task_attr) is not task
    finally:
        await stop()


@pytest.mark.asyncio
@pytest.mark.parametrize("module,task_attr,loop_attr,start_name,stop_name,flag,args", CASES)
async def test_stop_before_first_tick(monkeypatch, module, task_attr, loop_attr, start_name, stop_name, flag, args):
    monkeypatch.setattr(module, task_attr, None)
    if flag:
        monkeypatch.setattr(module, flag, False)
    mock = AsyncMock()
    monkeypatch.setattr(module, loop_attr, mock)
    await getattr(module, start_name)(*args)
    await getattr(module, stop_name)()
    mock.assert_not_awaited()
    assert getattr(module, task_attr) is None
    if flag:
        assert getattr(module, flag) is False
