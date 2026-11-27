import time
from dataclasses import replace
from decimal import Decimal
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

from backend.adapters.exchanges.base import OhlcvCandle
from backend.services.market_data.service import PriceSnapshot
from backend.services.signal_service import service as svc


def inputs(now):
    p = Decimal("100")
    snapshot = PriceSnapshot("BTCUSDT", p, p, p, 0.0, 0.0, p, "paper_live", "binance", now, False)
    candles = [OhlcvCandle(now - (29 - i) * 3600, p, p, p, p, p) for i in range(30)]
    return snapshot, candles


@pytest.mark.parametrize("case", ["stale", "future", "cached", "duplicate", "gap", "nan", "short", "wrong_symbol", "old_candles"])
def test_invalid_market_observations(case):
    now = int(time.time())
    snapshot, candles = inputs(now)
    if case == "stale":
        snapshot = replace(snapshot, stale=True)
    elif case == "future":
        snapshot = replace(snapshot, fetched_at=now + 1)
    elif case == "cached":
        snapshot = replace(snapshot, source="cache:1s_old")
    elif case == "duplicate":
        candles[1] = candles[0]
    elif case == "gap":
        candles.pop(1)
        candles.insert(0, replace(candles[0], time=candles[0].time - 3600))
    elif case == "nan":
        candles[-1] = replace(candles[-1], close=Decimal("NaN"))
    elif case == "short":
        candles.pop()
    elif case == "wrong_symbol":
        snapshot = replace(snapshot, symbol="ETHUSDT")
    elif case == "old_candles":
        candles = [replace(c, time=c.time - 7200) for c in candles]
    assert svc.prediction_input_error("BTCUSDT", snapshot, candles, now)


@pytest.mark.asyncio
async def test_existing_signal_cache_is_readiness_source(monkeypatch):
    from backend.app import app
    monkeypatch.setattr(svc, "_signal_cache", {})
    now = int(time.time())
    snapshot, candles = inputs(now)
    from backend.services.market_data.ingestion import CandleObservation
    observation = CandleObservation("BTCUSDT", "1h", "binance", now, tuple(candles))
    monkeypatch.setattr(svc, "_fetch_candles", AsyncMock(return_value=observation))
    monkeypatch.setattr(svc, "get_price", AsyncMock(return_value=snapshot))
    monkeypatch.setattr(svc, "_persist_signal", AsyncMock())
    assert svc.prediction_input_error("BTCUSDT", snapshot, candles, now) is None
    client = TestClient(app)
    url = "/api/v1/signals/prediction/BTCUSDT"
    assert client.get(url).json()["status"] == "not_reported"
    record = await svc.evaluate_signal("BTCUSDT")
    data = client.get(url).json()
    assert data["status"] == "available"
    assert data["signal_id"] == record.id
    assert data["execution_authorized"] is False
    assert data["provider_mutation_allowed"] is False
    assert data["worker_synchronized"] is False
    assert record.metadata["candle_source"] == "binance"
    assert record.metadata["trade_event_time_verified"] is False
    record.metadata["candle_observed_at"] = now - 76
    assert client.get(url).json()["status"] == "expired"
    record.metadata["candle_observed_at"] = now
    assert data["provider_clock"]["status"] == "not_reported"
    record.metadata.update(price_source="bitget", provider_timestamp_kind="bitget_ticker_current_time", provider_timestamp_ms=now * 1000)
    clock = client.get(url).json()["provider_clock"]
    assert clock["status"] == "current"
    assert clock["trade_event_time_verified"] is False
    record.metadata["provider_timestamp_ms"] = (now - 120) * 1000
    assert client.get(url).json()["provider_clock"]["status"] == "outside_window"
    assert svc._persist_signal.await_count == 1
    record.metadata["price_observed_at"] = now - 61
    assert client.get(url).json()["status"] == "expired"
    monkeypatch.setattr(svc, "get_price", AsyncMock(return_value=replace(snapshot, stale=True)))
    result = await svc.evaluate_signal("BTCUSDT")
    assert result.strategy_id == "no_data"
    assert result.entry_price == 0.0
    assert client.get(url).json()["signal"] is None
    assert client.get(url).json()["status"] == "unavailable"
    assert svc._persist_signal.await_count == 1
