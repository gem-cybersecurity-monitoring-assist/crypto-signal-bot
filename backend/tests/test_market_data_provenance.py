from dataclasses import replace
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from backend.adapters.exchanges.base import AdapterUnavailableError, Ticker
from backend.adapters.exchanges.bitget import BitgetAdapter
from backend.services.market_data import service as md


@pytest.mark.asyncio
@pytest.mark.parametrize("raw,expected", [
    ("1795622400123", 1795622400123), (None, None), ("1795622400", None),
    ("1795622400.123", None), (True, None), ("-795622400123", None),
])
async def test_bitget_response_clock(monkeypatch, raw, expected):
    adapter = BitgetAdapter(paper=True)
    monkeypatch.setattr(adapter, "_get_public", AsyncMock(return_value=[
        {"symbol": "BTCUSDT", "lastPr": "100", "ts": raw}
    ]))
    ticker = await adapter.fetch_ticker("BTCUSDT")
    assert ticker.provider_timestamp_ms == expected
    assert ticker.provider_timestamp_kind == ("bitget_ticker_current_time" if expected else None)


@pytest.mark.asyncio
async def test_wrong_bitget_symbol_rejected(monkeypatch):
    adapter = BitgetAdapter(paper=True)
    monkeypatch.setattr(adapter, "_get_public", AsyncMock(return_value=[
        {"symbol": "ETHUSDT", "lastPr": "100", "ts": "1795622400123"}
    ]))
    with pytest.raises(AdapterUnavailableError):
        await adapter.fetch_ticker("BTCUSDT")


@pytest.mark.asyncio
async def test_batch_rejects_duplicate_and_unrequested(monkeypatch):
    p = Decimal("100")
    btc = Ticker("BTCUSDT", p, p, p, p, 0.0, p, 100)
    adapter = SimpleNamespace(exchange_name="bitget", fetch_tickers=AsyncMock(
        return_value=[btc, btc, replace(btc, symbol="ETHUSDT")]))
    monkeypatch.setattr(md, "_get_adapters", AsyncMock(return_value=[adapter]))
    assert await md._fetch_tickers_with_failover(["BTCUSDT"]) == [(btc, "bitget")]


@pytest.mark.asyncio
async def test_provider_clock_preserved_in_snapshot_and_cache(monkeypatch):
    p = Decimal("100")
    ticker = Ticker("BTCUSDT", p, p, p, p, 0.0, p, 100, 1795622400123, "bitget_ticker_current_time")
    monkeypatch.setattr(md, "_redis_set", AsyncMock())
    monkeypatch.setattr(md, "_redis_publish", AsyncMock())
    snap = await md._process_ticker_payload(ticker, "bitget", 1795622401)
    assert snap.provider_timestamp_ms == ticker.provider_timestamp_ms
    assert snap.provider_timestamp_kind == ticker.provider_timestamp_kind
    assert snap.fetched_at == 1795622401
    with pytest.raises(md.MarketDataUnavailable):
        await md._process_ticker_payload(ticker, "bitget", 1795622401, requested_symbol="ETHUSDT")
