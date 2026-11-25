import time
from datetime import datetime, timezone
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient
from types import SimpleNamespace

from backend.services import runtime_comparison as rc


def fixture(now):
    return {
        "version": "2.0",
        "generated_at": datetime.fromtimestamp(now, timezone.utc).isoformat(),
        "runtime": {"trading_mode": "paper", "exchange_mode": "paper", "network": "testnet",
                    "allow_mainnet": False, "live_trading_enabled": False, "withdrawals_enabled": False},
        "guardian": {"halted": False, "reason": None},
        "projections": {"d1_status": "healthy"},
        "fast_path": {"authority": "legacy_d1"},
    }


@pytest.mark.parametrize("case", ["stale", "future", "missing", "bad_flag", "storage", "guardian_unavailable"])
def test_unknown_remote_never_claims_clear(case):
    now = time.time()
    p = fixture(now)
    if case == "stale":
        p = fixture(now - 31)
    elif case == "future":
        p = fixture(now + 3)
    elif case == "missing":
        del p["guardian"]
    elif case == "bad_flag":
        p["guardian"]["halted"] = 0
    elif case == "storage":
        p["projections"]["d1_status"] = "degraded"
    else:
        p["guardian"]["reason"] = "GUARDIAN_STATE_UNAVAILABLE"
    result = rc.worker_observation(p, now)
    assert result["halted"] is None
    assert rc.compare_observations({"status": "observed", "halted": False}, result)["guardian_comparison"] == "not_reported"


def test_comparison_does_not_confer_authority():
    now = time.time()
    remote = rc.worker_observation(fixture(now), now)
    assert remote["paper_locked"] is True
    for halted, expected in [(False, "match"), (True, "divergent")]:
        result = rc.compare_observations({"status": "observed", "halted": halted}, remote)
        assert result["guardian_comparison"] == expected
        assert result["guardian_authority_unified"] is False
        assert result["execution_authorized"] is False
        assert result["provider_mutation_allowed"] is False
        assert result["portfolio_reconciliation"] == "not_reported"


def test_missing_local_heartbeat_not_clear(monkeypatch):
    from backend.logic import context
    from backend.services.guardian_bot import service
    for module, attrs in [(context, ("kill_switch_active", "guardian_triggered")),
                          (service, ("_kill_switch_active", "_triggered"))]:
        for attr in attrs:
            monkeypatch.setattr(module, attr, False)
    monkeypatch.setattr(service, "_loop_running", False)
    assert rc.local_guardian_observation(time.time())["halted"] is None
    monkeypatch.setattr(context, "guardian_triggered", True)
    assert rc.local_guardian_observation(time.time())["halted"] is True


def test_endpoint_fails_closed_without_operator_key(monkeypatch):
    from backend.app import app
    from backend.routes import monitor_v1
    probe = AsyncMock(return_value={"execution_authorized": False})
    monkeypatch.setattr(rc, "runtime_comparison", probe)
    monkeypatch.setattr(monitor_v1, "get_auth_config", lambda: SimpleNamespace(api_key=None))
    client = TestClient(app)
    url = "/api/v1/monitor/runtime-comparison"
    assert client.get(url).status_code == 401
    monkeypatch.setattr(monitor_v1, "get_auth_config", lambda: SimpleNamespace(api_key="test-only"))
    assert client.get(url, headers={"X-API-Key": "wrong"}).status_code == 401
    probe.assert_not_awaited()
    assert client.get(url, headers={"X-API-Key": "test-only"}).json()["execution_authorized"] is False
    probe.assert_awaited_once()


@pytest.mark.asyncio
@pytest.mark.parametrize("case", ["valid", "redirect", "oversized", "invalid_json", "encoded", "wrong_type"])
async def test_worker_transport_is_bounded(monkeypatch, case):
    import json
    import httpx

    requests = []
    original_client = httpx.AsyncClient

    class Body(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield raw

    raw = json.dumps(fixture(time.time())).encode()
    headers = {"Content-Type": "application/json"}
    status = 200
    if case == "redirect":
        status = 302
        headers["Location"] = "https://example.org/unexpected"
    elif case == "oversized":
        raw = b" " * (rc.MAX_RESPONSE_BYTES + 1)
    elif case == "invalid_json":
        raw = b"{"
    elif case == "encoded":
        headers["Content-Encoding"] = "gzip"
    elif case == "wrong_type":
        headers["Content-Type"] = "text/html"

    async def handler(request):
        requests.append(request)
        return httpx.Response(status, headers=headers, stream=Body())

    def client_factory(**kwargs):
        assert kwargs["trust_env"] is False
        assert kwargs["follow_redirects"] is False
        return original_client(transport=httpx.MockTransport(handler), **kwargs)

    monkeypatch.setattr(rc.httpx, "AsyncClient", client_factory)
    result = await rc.fetch_worker_observation()
    assert len(requests) == 1
    assert requests[0].method == "GET"
    assert str(requests[0].url) == rc.WORKER_STATUS_URL
    assert "Authorization" not in requests[0].headers
    assert "X-API-Key" not in requests[0].headers
    if case == "valid":
        assert result["status"] == "observed"
    else:
        assert result["status"] == "unavailable"
        assert result["halted"] is None


def test_local_clear_requires_actual_monitor_cycle(monkeypatch):
    from backend.logic import context
    from backend.services.guardian_bot import monitor, service
    now = int(time.time())
    for module, attrs in [(context, ("kill_switch_active", "guardian_triggered")),
                          (service, ("_kill_switch_active", "_triggered"))]:
        for attr in attrs:
            monkeypatch.setattr(module, attr, False)
    monkeypatch.setattr(service, "_last_heartbeat_at", now)
    monkeypatch.setattr(service, "_loop_running", True)
    monkeypatch.setattr(monitor, "_monitor_task", SimpleNamespace(done=lambda: False))
    monkeypatch.setattr(monitor, "_last_successful_cycle_at", None)
    assert rc.local_guardian_observation(now)["halted"] is None
    monkeypatch.setattr(monitor, "_last_successful_cycle_at", now)
    monkeypatch.setattr(service, "_strategy_kill_switches", {"research"})
    monkeypatch.setattr(service, "_reconciliation_drift_count", 1)
    monkeypatch.setattr(service, "is_in_cooldown", lambda: True)
    result = rc.local_guardian_observation(now)
    assert result["halted"] is False
    assert result["scope"] == "local_global_halt_only"
    assert result["redis_verified"] is False
    assert result["scoped_halts_present"] is True
    assert result["reconciliation_drift"] is True
    assert result["cooldown_active"] is True
    assert rc.compare_observations(result, rc.worker_observation(fixture(now), now))["shared_clearance_verified"] is False
    assert rc.local_guardian_observation(now + 91)["halted"] is None
    monkeypatch.setattr(monitor, "_monitor_task", SimpleNamespace(done=lambda: True))
    assert rc.local_guardian_observation(now)["halted"] is None


def test_worker_nonpaper_observation_not_comparable():
    now = time.time()
    payload = fixture(now)
    payload["runtime"]["allow_mainnet"] = True
    result = rc.worker_observation(payload, now)
    assert result["status"] == "runtime_unverified"
    assert result["halted"] is None
