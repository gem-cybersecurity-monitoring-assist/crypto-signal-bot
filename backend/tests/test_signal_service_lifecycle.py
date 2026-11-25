"""Lifecycle regression tests for the existing analytical signal loop."""
import asyncio
from unittest.mock import AsyncMock

import pytest

from backend.services.signal_service import service as svc


@pytest.mark.asyncio
async def test_duplicate_start_and_shutdown_preserve_single_task(monkeypatch):
    monkeypatch.setattr(svc, "_eval_task", None)
    monkeypatch.setattr(svc, "_running", False)
    monkeypatch.setattr(svc, "_signal_cache", {})
    monkeypatch.setattr(svc, "_last_eval", {})
    monkeypatch.setattr(svc, "_SYMBOLS", ["BTCUSDT"])
    entered = asyncio.Event()
    cancelled = asyncio.Event()

    async def evaluate(symbol):
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    probe = AsyncMock(side_effect=evaluate)
    monkeypatch.setattr(svc, "evaluate_signal", probe)
    try:
        await svc.start_signal_service(None)
        original = svc._eval_task
        await svc.start_signal_service(None)
        assert svc._eval_task is original
        await asyncio.wait_for(entered.wait(), timeout=1)
        assert svc.get_signal_service_status()["running"] is True
        probe.assert_awaited_once_with("BTCUSDT")
        svc._signal_cache["BTCUSDT"] = object()
        svc._last_eval["BTCUSDT"] = 1.0
        await svc.stop_signal_service()
        assert cancelled.is_set()
        assert original.cancelled()
        assert svc._eval_task is None
        assert svc.get_signal_service_status()["running"] is False
        assert svc.get_cached_signal("BTCUSDT") is None
        assert not svc._last_eval
        await svc.stop_signal_service()
    finally:
        await svc.stop_signal_service()


@pytest.mark.asyncio
async def test_start_stop_before_first_evaluation(monkeypatch):
    monkeypatch.setattr(svc, "_eval_task", None)
    monkeypatch.setattr(svc, "_running", False)
    monkeypatch.setattr(svc, "_signal_cache", {})
    monkeypatch.setattr(svc, "_last_eval", {})
    evaluator = AsyncMock()
    monkeypatch.setattr(svc, "evaluate_signal", evaluator)
    try:
        await svc.start_signal_service(None)
        await svc.stop_signal_service()
        evaluator.assert_not_awaited()
        assert svc._eval_task is None
        assert not svc.get_signal_service_status()["running"]
        await svc.start_signal_service(None)
        assert svc._eval_task is not None
        assert not svc._eval_task.done()
    finally:
        await svc.stop_signal_service()
