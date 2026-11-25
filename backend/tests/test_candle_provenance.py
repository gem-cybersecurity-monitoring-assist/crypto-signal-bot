import asyncio
import time
from dataclasses import replace
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from backend.adapters.exchanges.base import OhlcvCandle
from backend.services.market_data import ingestion as ingest
from backend.services.signal_service import service as signals


def candles(now, price="100", n=30):
    p = Decimal(price)
    return [OhlcvCandle(now - (n - 1 - i) * 3600, p, p, p, p, p) for i in range(n)]


@pytest.mark.asyncio
async def test_provider_switch_does_not_mix_histories(monkeypatch):
    pipeline = ingest.IngestionPipeline()
    pipeline._semaphore = asyncio.Semaphore(1)
    now = int(time.time())
    a = SimpleNamespace(exchange_name="binance", fetch_ohlcv=AsyncMock(return_value=candles(now)))
    b = SimpleNamespace(exchange_name="bitget", fetch_ohlcv=AsyncMock(return_value=candles(now, "200", 5)))
    monkeypatch.setattr(ingest, "_get_adapters", AsyncMock(return_value=[a]))
    await pipeline._fetch_symbol("BTCUSDT")
    assert pipeline.get_observation("BTCUSDT", 30).source == "binance"
    a.fetch_ohlcv.return_value = []
    monkeypatch.setattr(ingest, "_get_adapters", AsyncMock(return_value=[a, b]))
    await pipeline._fetch_symbol("BTCUSDT")
    obs = pipeline.get_observation("BTCUSDT", 30)
    assert obs.source == "bitget"
    assert obs.candles == tuple(b.fetch_ohlcv.return_value)
    assert pipeline.get_candles("BTCUSDT") == b.fetch_ohlcv.return_value
    b.fetch_ohlcv.side_effect = RuntimeError("unavailable")
    await pipeline._fetch_symbol("BTCUSDT")
    assert pipeline.get_observation("BTCUSDT", 30) is None


@pytest.mark.asyncio
async def test_duplicate_batch_not_hidden_by_ring_dedup(monkeypatch):
    pipeline = ingest.IngestionPipeline()
    pipeline._semaphore = asyncio.Semaphore(1)
    now = int(time.time())
    batch = candles(now)
    batch[1] = batch[0]
    a = SimpleNamespace(exchange_name="binance", fetch_ohlcv=AsyncMock(return_value=batch))
    monkeypatch.setattr(ingest, "_get_adapters", AsyncMock(return_value=[a]))
    await pipeline._fetch_symbol("BTCUSDT")
    assert len(pipeline.get_candles("BTCUSDT")) == 29
    obs = pipeline.get_observation("BTCUSDT", 30)
    assert obs.candles[0].time == obs.candles[1].time


def test_expired_observation_not_returned():
    pipeline = ingest.IngestionPipeline()
    now = int(time.time())
    pipeline._observations["BTCUSDT"] = ingest.CandleObservation(
        "BTCUSDT", "1h", "binance", now - 76, tuple(candles(now))
    )
    assert pipeline.get_observation("BTCUSDT", 30) is None
    pipeline.set_active_symbols(["ETHUSDT"])
    assert "BTCUSDT" not in pipeline._observations


@pytest.mark.asyncio
async def test_strict_fetch_skips_unattributed_and_synthetic_sources(monkeypatch):
    from backend.services.market_data import service as md
    now = int(time.time())
    a = SimpleNamespace(exchange_name="coingecko", fetch_ohlcv=AsyncMock(return_value=candles(now)))
    b = SimpleNamespace(exchange_name="bitget", fetch_ohlcv=AsyncMock(return_value=candles(now)))
    monkeypatch.setattr(ingest, "get_candle_observation", lambda *_: None)
    monkeypatch.setattr(signals, "_get_ohlcv_adapter", AsyncMock(return_value=None))
    monkeypatch.setattr(md, "_get_adapters", AsyncMock(return_value=[a, b]))
    obs = await signals._fetch_candles("BTCUSDT", require_provenance=True)
    assert obs.source == "bitget"
    assert obs.candles == tuple(b.fetch_ohlcv.return_value)
    a.fetch_ohlcv.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("source", ["coingecko", "unknown", "btcc"])
async def test_unverified_source_cannot_populate_prediction(monkeypatch, source):
    now = int(time.time())
    obs = ingest.CandleObservation("BTCUSDT", "1h", source, now, tuple(candles(now)))
    monkeypatch.setattr(signals, "_fetch_candles", AsyncMock(return_value=obs))
    monkeypatch.setattr(signals, "get_price", AsyncMock(return_value=None))
    monkeypatch.setattr(signals, "_persist_signal", AsyncMock())
    monkeypatch.setattr(signals, "_signal_cache", {})
    rec = await signals.evaluate_signal("BTCUSDT")
    assert rec.strategy_id == "no_data"
    assert rec.metadata["reason"] == "candle_provenance_unavailable"
    signals._persist_signal.assert_not_awaited()
