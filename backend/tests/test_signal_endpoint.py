"""Read-only compatibility route must agree with the versioned observation."""
import time
from dataclasses import replace
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

from backend.app import app
from backend.logic.signal_engine import SignalRecord
from backend.services.signal_service import service as svc


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(svc, "_signal_cache", {})
    return TestClient(app)


def record(now, side="BUY"):
    return SignalRecord(
        id="observation-id", symbol="BTCUSDT", timeframe="1h", side=side,
        entry_price=100.0, stop_loss=None, take_profit=None, confidence=0.725,
        strategy_id="combined", created_at=now, valid_until=now + 900,
        metadata={"prediction_input_status": "validated_observations",
                  "price_observed_at": now, "candle_provenance": "adapter_attributed_batch",
                  "candle_observed_at": now},
    )


def test_no_symbol_returns_unavailable(client):
    data = client.get("/signal/latest").json()
    assert data["available"] is False
    assert data["direction"] == data["side"] == "NEUTRAL"
    assert data["message"]


@pytest.mark.parametrize("side,direction,legacy_side", [
    ("BUY", "UP", "BUY"), ("SELL", "DOWN", "SELL"), ("FLAT", "NEUTRAL", "NEUTRAL")
])
def test_same_validated_observation(client, monkeypatch, side, direction, legacy_side):
    now = int(time.time())
    svc._signal_cache["BTCUSDT"] = record(now, side)
    evaluate = AsyncMock()
    monkeypatch.setattr(svc, "evaluate_signal", evaluate)
    legacy = client.get("/signal/latest?symbol=btcusdt").json()
    v1 = client.get("/api/v1/signals/prediction/BTCUSDT").json()
    assert legacy["available"] is True
    assert legacy["symbol"] == "BTCUSDT"
    assert legacy["direction"] == direction
    assert legacy["side"] == legacy_side
    assert legacy["confidence"] == pytest.approx(72.5)
    assert legacy["signal_id"] == v1["signal_id"] == "observation-id"
    assert legacy["readiness_status"] == v1["status"] == "available"
    assert legacy["computed_at"] == now
    assert legacy["source"] == "python_signal_service_cache"
    assert legacy["regime"] == "UNKNOWN" and legacy["horizon"] == 0
    assert legacy["regime_verified"] is False
    assert legacy["forecast_horizon_verified"] is False
    assert legacy["execution_authorized"] is False
    assert legacy["worker_synchronized"] is False
    evaluate.assert_not_awaited()


@pytest.mark.parametrize("case,expected", [
    ("missing", "not_reported"), ("stale", "expired"), ("wrong_symbol", "unverified"),
    ("nan", "unverified"), ("no_provenance", "unverified"), ("no_data", "unavailable")
])
def test_unclear_observations_agree(client, case, expected):
    now = int(time.time())
    obs = record(now)
    if case == "stale":
        obs.metadata["price_observed_at"] = now - 61
    elif case == "wrong_symbol":
        obs = replace(obs, symbol="ETHUSDT")
    elif case == "nan":
        obs = replace(obs, confidence=float("nan"))
    elif case == "no_provenance":
        obs.metadata.clear()
    elif case == "no_data":
        obs = replace(obs, strategy_id="no_data")
    if case != "missing":
        svc._signal_cache["BTCUSDT"] = obs
    legacy = client.get("/signal/latest?symbol=BTCUSDT").json()
    v1 = client.get("/api/v1/signals/prediction/BTCUSDT").json()
    assert legacy["available"] is False
    assert legacy["direction"] == "NEUTRAL"
    assert legacy["confidence"] == 0
    assert legacy["readiness_status"] == v1["status"] == expected
    assert v1["signal"] is None


def test_prediction_status_uses_running_service(client, monkeypatch):
    monkeypatch.setattr(svc, "_running", True)
    svc._signal_cache["BTCUSDT"] = record(int(time.time()))
    data = client.get("/prediction/status").json()
    assert data["running"] is True
    assert data["cached_symbols"] == ["BTCUSDT"]
    assert isinstance(data["tracked_symbols"], int)
    assert data["worker_synchronized"] is False
