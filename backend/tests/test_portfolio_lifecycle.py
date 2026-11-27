"""Lifecycle tests with mocked existing paper loops and persistence only."""
import asyncio
from unittest.mock import AsyncMock

import pytest

from backend.services.portfolio import service as svc


@pytest.fixture
def isolated(monkeypatch):
    monkeypatch.setattr(svc, "_portfolio_tasks", set())
    monkeypatch.setattr(svc, "_persistence_tasks", set())
    monkeypatch.setattr(svc, "_portfolio_stop", None)
    monkeypatch.setattr(svc, "_portfolio_starting", False)
    monkeypatch.setattr(svc, "_SHUTDOWN_TIMEOUT", 0.1)
    restore = AsyncMock()
    monkeypatch.setattr(svc, "restore_portfolio_state", restore)
    return restore


@pytest.mark.asyncio
async def test_repeated_start_and_graceful_stop(monkeypatch, isolated):
    entered = asyncio.Event()
    completed = asyncio.Event()

    async def loop():
        entered.set()
        assert await svc._next_tick(3600) is False
        completed.set()

    monkeypatch.setattr(svc, "_snapshot_loop", loop)
    monkeypatch.setattr(svc, "_limit_fill_loop", loop)
    try:
        await svc.start_portfolio_service(None)
        original = svc._portfolio_tasks.copy()
        await svc.start_portfolio_service(None)
        isolated.assert_awaited_once()
        assert len(original) == 2
        assert svc._portfolio_tasks == original
        await asyncio.wait_for(entered.wait(), 1)
        await svc.stop_portfolio_service()
        assert completed.is_set()
        assert all(t.done() and not t.cancelled() for t in original)
        assert not svc._portfolio_tasks
        await svc.stop_portfolio_service()
    finally:
        await svc.stop_portfolio_service()


@pytest.mark.asyncio
async def test_shutdown_drains_pending_persistence(isolated):
    completed = asyncio.Event()

    async def write():
        await asyncio.sleep(0)
        completed.set()

    svc._schedule_persistence(write())
    assert len(svc._persistence_tasks) == 1
    await svc.stop_portfolio_service()
    assert completed.is_set()
    assert not svc._persistence_tasks


@pytest.mark.asyncio
async def test_shutdown_timeout_reports_incomplete(monkeypatch, isolated):
    monkeypatch.setattr(svc, "_SHUTDOWN_TIMEOUT", 0.01)

    async def write():
        await asyncio.Event().wait()

    svc._schedule_persistence(write())
    task = next(iter(svc._persistence_tasks))
    with pytest.raises(RuntimeError, match="completeness unverified"):
        await svc.stop_portfolio_service()
    assert task.cancelled()
    assert not svc._persistence_tasks


@pytest.mark.asyncio
async def test_restore_failure_starts_no_loops(isolated):
    isolated.side_effect = RuntimeError("restore unavailable")
    with pytest.raises(RuntimeError, match="restore unavailable"):
        await svc.start_portfolio_service(None)
    assert not svc._portfolio_tasks
    assert svc._portfolio_stop is None
    assert not svc._portfolio_starting
