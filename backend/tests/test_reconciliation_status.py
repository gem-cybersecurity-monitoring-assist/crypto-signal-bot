"""Regression tests for reconciliation status endpoint."""

from fastapi.testclient import TestClient

import backend.services.reconciliation.service as reconciliation_service
from backend.app import app


def test_reconciliation_status_returns_no_report_when_reconciliation_has_not_run(monkeypatch):
    from unittest.mock import AsyncMock
    monkeypatch.setattr(reconciliation_service, "get_latest_report", AsyncMock(return_value=None))
    client = TestClient(app)

    response = client.get("/reconciliation/status")

    assert response.status_code == 200
    assert response.json() == {
        "status": "no_report",
        "message": "Reconciliation has not run yet.",
    }


def test_legacy_report_without_provenance_is_unverified(monkeypatch):
    report = {
        "usdt_balance": 10000.0,
        "total_realized_pnl": 125.5,
        "trade_count": 3,
        "created_at": 1_700_000_000,
    }
    monkeypatch.setattr(reconciliation_service, "_last_report", report)
    client = TestClient(app)

    response = client.get("/reconciliation/status")

    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "unverified"
    assert data["ledger_reconciled"] is False
    assert data["worker_reconciled"] is False
    assert data["report"] == reconciliation_service._last_report
