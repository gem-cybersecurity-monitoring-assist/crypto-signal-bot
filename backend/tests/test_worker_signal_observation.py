import time
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi.testclient import TestClient

from backend.services.signal_service import worker_observation as obs


def payload(now):
    return {"version": "1.0", "source": "worker_d1_signal_history", "symbol": "BTC",
            "observed_at_ms": now, "status": "historical", "event_time_verified": False,
            "sequence_verified": False, "execution_authorized": False,
            "observation": {"id": "signal:BTC:42", "row_id": 42, "timeframe": "5m",
                            "side": "BUY", "confidence": 0.7, "recorded_at_ms": now - 1000}}


@pytest.mark.parametrize("change", ["symbol", "authority", "sequence", "identity", "confidence", "future", "stale"])
def test_invalid_evidence_never_accepted(change):
    now = int(time.time() * 1000)
    p = payload(now)
    if change == "symbol":
        p["symbol"] = "ETH"
    elif change == "authority":
        p["execution_authorized"] = True
    elif change == "sequence":
        p["sequence_verified"] = True
    elif change == "identity":
        p["observation"]["id"] = "signal:ETH:42"
    elif change == "confidence":
        p["observation"]["confidence"] = float("nan")
    elif change == "future":
        p["observation"]["recorded_at_ms"] = now + 1
    else:
        p["observed_at_ms"] = now - 30001
    assert obs.parse_worker_observation(p, "BTC", now)["observation"] is None


@pytest.mark.asyncio
async def test_missing_key_no_network(monkeypatch):
    monkeypatch.delenv("SIGNAL_OBSERVATION_READ_KEY", raising=False)
    client = AsyncMock()
    monkeypatch.setattr(obs.httpx, "AsyncClient", client)
    assert (await obs.fetch_worker_signal("BTC"))["status"] == "not_configured"
    client.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["valid", "redirect", "oversized", "auth"])
async def test_transport_uses_dedicated_key_only(monkeypatch, kind):
    key = "read-only-test-key" * 3
    monkeypatch.setenv("SIGNAL_OBSERVATION_READ_KEY", key)
    requests = []
    original = httpx.AsyncClient

    class Body(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield b" " * (obs.MAX_BYTES + 1) if kind == "oversized" else json.dumps(payload(int(time.time()*1000))).encode()

    async def handler(request):
        requests.append(request)
        return httpx.Response({"redirect":302, "auth":401}.get(kind, 200),
                              headers={"Content-Type":"application/json", "Location":"https://example.org"},
                              stream=Body())

    def factory(**kwargs):
        assert not kwargs["follow_redirects"] and not kwargs["trust_env"]
        return original(transport=httpx.MockTransport(handler), **kwargs)

    monkeypatch.setattr(obs.httpx, "AsyncClient", factory)
    result = await obs.fetch_worker_signal("BTC")
    assert len(requests) == 1
    assert str(requests[0].url) == obs.URL + "?symbol=BTC"
    assert requests[0].method == "GET"
    assert requests[0].headers["X-Signal-Observation-Key"] == key
    assert "X-API-Key" not in requests[0].headers and "Authorization" not in requests[0].headers
    assert result["status"] == {"valid":"historical", "auth":"authentication_required"}.get(kind,"unavailable")


def test_operator_boundary_and_no_shared_event_claim(monkeypatch):
    from backend.app import app
    from backend.routes import monitor_v1
    monkeypatch.setattr(monitor_v1, "get_auth_config", lambda: SimpleNamespace(api_key="operator-test"))
    remote = AsyncMock(return_value={"status": "historical", "observation": payload(0)["observation"]})
    monkeypatch.setattr(obs, "fetch_worker_signal", remote)
    monkeypatch.setattr(obs, "read_observation", lambda s: (None,"not_reported",{}))
    client = TestClient(app)
    route = "/api/v1/monitor/signal-comparison/"
    assert client.get(route+"BTCUSDT").status_code == 401
    assert client.get(route+"BTC", headers={"X-API-Key":"operator-test"}).status_code == 400
    remote.assert_not_awaited()
    data = client.get(route+"BTCUSDT", headers={"X-API-Key":"operator-test"}).json()
    assert data["worker"]["status"] == "historical"
    assert data["signal_synchronization"] == "not_verified"
    assert data["shared_event_verified"] is False
    assert data["execution_authorized"] is False
    remote.assert_awaited_once_with("BTC")
