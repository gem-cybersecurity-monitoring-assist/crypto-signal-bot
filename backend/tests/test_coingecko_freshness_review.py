import time
from unittest.mock import AsyncMock
import pytest
from backend.adapters.exchanges import coingecko as cg
from backend.services.market_data import service as market
from backend.adapters.exchanges.base import AdapterUnavailableError


@pytest.mark.asyncio
async def test_failed_refresh_does_not_relabel_old_quotes(monkeypatch):
    monkeypatch.setattr(cg, "_cache_ts", time.time()-100)
    monkeypatch.setattr(cg, "_fetch_all_cached", AsyncMock(return_value=({"bitcoin":{"usd":100}}, "429")))
    monkeypatch.setattr(market, "_cg_dedup_ts", 0)
    monkeypatch.setattr(market, "_cg_dedup_cache", {})
    with pytest.raises(AdapterUnavailableError):
        await cg.CoinGeckoAdapter().fetch_ticker("BTCUSDT")
    with pytest.raises(AdapterUnavailableError):
        await market._get_coingecko_ticker_deduped("BTCUSDT")


@pytest.mark.asyncio
async def test_cached_success_preserves_original_observation_time(monkeypatch):
    observed = int(time.time())-5
    monkeypatch.setattr(cg, "_cache_ts", float(observed))
    monkeypatch.setattr(cg, "_fetch_all_cached", AsyncMock(return_value=({"bitcoin":{"usd":100}}, None)))
    monkeypatch.setattr(market, "_cg_dedup_ts", 0)
    monkeypatch.setattr(market, "_cg_dedup_cache", {})
    ticker = await market._get_coingecko_ticker_deduped("BTCUSDT")
    assert ticker.timestamp == observed
    assert (await cg.CoinGeckoAdapter().fetch_ticker("BTCUSDT")).timestamp == observed
    assert (await market._get_coingecko_ticker_deduped("BTCUSDT")).timestamp == observed
