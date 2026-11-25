"""Diagnostic report persistence and unavailable-state tests on temporary SQLite."""
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

from backend.db import session as db
from backend.engine import pnl
from backend.services.reconciliation import service as recon


@pytest.fixture
def isolated(monkeypatch, tmp_path):
    monkeypatch.setattr(recon, "_last_report", None)
    monkeypatch.setattr(recon, "get_exchange_config", lambda: SimpleNamespace(mode="paper"))
    monkeypatch.setattr(db, "_engine", None)
    monkeypatch.setattr(db, "_session_factory", None)
    monkeypatch.setattr(db, "get_database_config", lambda: SimpleNamespace(
        url=f"sqlite:///{tmp_path / 'recon.db'}", echo=False, pool_size=1, max_overflow=0))
    monkeypatch.setattr(pnl, "get_usdt_balance", lambda: 1000.0)
    monkeypatch.setattr(pnl, "get_all_lots", lambda: {})
    monkeypatch.setattr(pnl, "get_pnl_summary", AsyncMock(return_value=SimpleNamespace(
        total_realized_pnl=0.0, total_unrealized_pnl=0.0, trade_count=0)))


@pytest.mark.asyncio
async def test_report_survives_process_cache_loss(isolated, monkeypatch):
    try:
        await db.init_db()
        await recon.run_reconciliation()
        current = await recon.get_latest_report()
        assert current["persistence_status"] == "committed"
        assert current["observation_status"] == "observed"
        assert current["usdt_balance"] == 1000
        recon._last_report = None
        restored = await recon.get_latest_report()
        assert restored["observation_status"] == "historical"
        assert restored["usdt_balance"] == current["usdt_balance"]
        assert restored["persistence_status"] == "committed"
        monkeypatch.setattr(recon, "get_exchange_config", lambda: SimpleNamespace(mode="other"))
        assert await recon.get_latest_report() is None
    finally:
        await db.close_db()


@pytest.mark.asyncio
async def test_failed_observation_supersedes_previous_success(isolated, monkeypatch):
    monkeypatch.setattr(recon, "_persist_report", AsyncMock())
    await recon.run_reconciliation()
    pnl.get_pnl_summary.side_effect = RuntimeError("private exception")
    result = await recon.run_reconciliation()
    report = await recon.get_latest_report()
    assert result.discrepancy_detected is True
    assert report["observation_status"] == "unavailable"
    assert report["usdt_balance"] is None
    assert report["persistence_status"] == "not_written"
    assert "private exception" not in str(report)
    recon._persist_report.assert_awaited_once()


@pytest.mark.asyncio
async def test_unavailable_database_not_reported_as_committed(isolated):
    await recon.run_reconciliation()
    assert (await recon.get_latest_report())["persistence_status"] == "unavailable"


@pytest.mark.asyncio
async def test_nonfinite_observation_rejected(isolated, monkeypatch):
    monkeypatch.setattr(pnl, "get_usdt_balance", lambda: float("nan"))
    await recon.run_reconciliation()
    assert (await recon.get_latest_report())["observation_status"] == "unavailable"


@pytest.mark.parametrize("state,age,drift,expected", [
    ("observed", 0, False, "observed"), ("observed", 0, True, "discrepancy"),
    ("observed", 601, False, "expired"), ("historical", 0, False, "historical"),
    ("unavailable", 0, True, "unavailable"),
])
def test_api_never_claims_ledger_reconciled(monkeypatch, state, age, drift, expected):
    from backend.app import app
    monkeypatch.setattr(recon, "get_latest_report", AsyncMock(return_value={
        "observation_status": state, "created_at": int(time.time()) - age,
        "discrepancy_detected": drift,
    }))
    response = TestClient(app).get("/reconciliation/status")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == expected
    assert data["ledger_reconciled"] is False
    assert data["worker_reconciled"] is False
