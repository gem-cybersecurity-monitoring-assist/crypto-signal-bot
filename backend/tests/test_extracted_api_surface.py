"""Regression contract for the extracted FastAPI route modules."""
from collections import Counter
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

from backend.app import app


@pytest.mark.parametrize("path,method", [
    ("/config", "get"), ("/config/snapshot", "get"),
    ("/version", "get"), ("/runtime/status", "get"),
    ("/mainnet-gate/status", "get"), ("/exchange/status", "get"),
    ("/exchange/supported", "get"), ("/exchange/circuit-breakers", "get"),
    ("/exchange/validate", "get"), ("/exchange/test-connection", "post"),
    ("/market/feed/status", "get"), ("/surge/status", "get"),
    ("/balance", "get"), ("/positions", "get"), ("/orders", "get"),
    ("/price", "get"), ("/market-state", "post"),
    ("/intent/paper", "post"), ("/intent/live", "post"),
    ("/withdraw", "post"), ("/reconciliation/status", "get"),
    ("/reconciliation/exchange", "get"), ("/signal/latest", "get"),
    ("/prediction/status", "get"), ("/api/v1/signals/prediction/{symbol}", "get"),
    ("/api/v1/monitor/runtime-comparison", "get"),
])
def test_documented_route_is_in_openapi(path, method):
    assert method in app.openapi()["paths"][path]


def test_operation_ids_unique_and_no_double_prefix():
    paths = app.openapi()["paths"]
    ids = [operation["operationId"] for methods in paths.values()
           for operation in methods.values()
           if isinstance(operation, dict) and "operationId" in operation]
    assert not [name for name, count in Counter(ids).items() if count > 1]
    assert not [path for path in paths if "/api/v1/" in path.removeprefix("/api/v1/")]


def test_reconciliation_missing_report_is_explicit(monkeypatch):
    from backend.services.reconciliation import service
    reader = AsyncMock(return_value=None)
    monkeypatch.setattr(service, "get_latest_report", reader)
    response = TestClient(app).get("/reconciliation/status")
    assert response.status_code == 200
    assert response.json()["status"] == "no_report"
    assert "report" not in response.json()
    reader.assert_awaited_once()


def test_live_and_withdrawal_routes_cannot_dispatch(monkeypatch):
    import backend.app as app_module
    from backend import app_state

    def unexpected(*args, **kwargs):
        pytest.fail("blocked route reached intent dispatch")

    monkeypatch.setattr(app_state, "process_intent", unexpected)
    monkeypatch.setattr(app_module, "BACKEND_API_KEY", "contract-test-key")
    client = TestClient(app)
    headers = {"X-API-Key": "contract-test-key"}
    intent = {"symbol": "BTCUSDT", "side": "BUY", "quantity": 0.001}
    assert client.post("/intent/live", json=intent, headers=headers).status_code == 403
    assert client.post("/withdraw", json={}, headers=headers).status_code == 403
    assert client.post("/intent/live", json=intent).status_code == 401
