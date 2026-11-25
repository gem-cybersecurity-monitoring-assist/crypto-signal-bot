"""Bounded, read-only comparison of Python and canonical Worker observations.

This is monitoring evidence, not an execution gate or a state writer.
"""
from __future__ import annotations

import asyncio
import json
import time
from datetime import datetime, timezone

import httpx

WORKER_STATUS_URL = "https://crypto-signal-bot-api.analyzer-d94.workers.dev/v2/infrastructure/status"
MAX_RESPONSE_BYTES = 128 * 1024
MAX_AGE_SECONDS = 30


def worker_observation(payload: object, now: float) -> dict:
    """Reject missing, stale and malformed evidence rather than infer health."""
    unknown = {"status": "unverified", "halted": None, "authority": None, "paper_locked": None}
    try:
        if not isinstance(payload, dict) or payload.get("version") != "2.0":
            return unknown
        stamp = payload["generated_at"]
        if not isinstance(stamp, str):
            return unknown
        observed = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
        if observed.tzinfo is None or not -2 <= now - observed.timestamp() <= MAX_AGE_SECONDS:
            return {**unknown, "status": "expired"}
        runtime = payload["runtime"]
        guardian = payload["guardian"]
        projections = payload["projections"]
        path = payload["fast_path"]
        if not all(isinstance(x, dict) for x in (runtime, guardian, projections, path)):
            return unknown
        locks = (
            runtime.get("trading_mode") == "paper"
            and runtime.get("exchange_mode") == "paper"
            and runtime.get("network") == "testnet"
            and all(runtime.get(k) is False for k in (
                "allow_mainnet", "live_trading_enabled", "withdrawals_enabled"
            ))
        )
        if not locks:
            return {**unknown, "status": "runtime_unverified", "paper_locked": False}
        authority = path.get("authority")
        if authority not in ("legacy_d1", "shadow_durable_object", "portfolio_durable_object"):
            authority = None
        halted = guardian.get("halted")
        if type(halted) is not bool:
            return unknown
        if projections.get("d1_status") != "healthy" or guardian.get("reason") == "GUARDIAN_STATE_UNAVAILABLE":
            return {**unknown, "status": "storage_unverified", "paper_locked": locks, "authority": authority}
        return {
            "status": "observed", "halted": halted, "authority": authority,
            "paper_locked": locks, "observed_at": observed.isoformat(),
        }
    except (KeyError, TypeError, ValueError, OverflowError, AttributeError):
        return unknown


async def fetch_worker_observation() -> dict:
    """Fixed HTTPS GET only, no redirects, credentials, or unbounded reads."""
    try:
        async with asyncio.timeout(5):
            async with httpx.AsyncClient(
                timeout=4.0, follow_redirects=False, trust_env=False,
                headers={"Accept": "application/json", "Accept-Encoding": "identity"},
            ) as client:
                async with client.stream("GET", WORKER_STATUS_URL) as response:
                    if response.status_code != 200:
                        raise ValueError("unexpected status")
                    if response.headers.get("content-type", "").split(";")[0].strip().lower() != "application/json":
                        raise ValueError("unexpected content type")
                    if response.headers.get("content-encoding", "identity").lower() != "identity":
                        raise ValueError("unexpected encoding")
                    data = bytearray()
                    async for chunk in response.aiter_raw(chunk_size=8192):
                        if len(data) + len(chunk) > MAX_RESPONSE_BYTES:
                            raise ValueError("response exceeds limit")
                        data.extend(chunk)
        return worker_observation(json.loads(data), time.time())
    except (TimeoutError, httpx.HTTPError, ValueError, UnicodeError, RecursionError):
        return {"status": "unavailable", "halted": None, "authority": None, "paper_locked": None}


def local_guardian_observation(now: float) -> dict:
    """Snapshot the existing state without calling a provider or changing it."""
    from backend.logic import context
    from backend.services.guardian_bot import monitor
    from backend.services.guardian_bot import service as guardian

    flags = (guardian._kill_switch_active, guardian._triggered, context.kill_switch_active, context.guardian_triggered)
    evidence = {"scope": "local_global_halt_only", "redis_verified": False,
                "scoped_halts_present": bool(guardian._strategy_kill_switches or guardian._venue_kill_switches),
                "reconciliation_drift": guardian._reconciliation_drift_count > 0,
                "cooldown_active": guardian.is_in_cooldown()}
    if any(flag is True for flag in flags):
        return {**evidence, "status": "observed", "halted": True}
    if not all(type(flag) is bool for flag in flags):
        return {**evidence, "status": "unverified", "halted": None}
    # Generic application heartbeats do not prove that the portfolio Guardian
    # has performed a successful check. Observe the actual launched monitor.
    task = monitor._monitor_task
    heartbeat = monitor._last_successful_cycle_at
    if task is None or task.done() or type(heartbeat) is not int or not 0 <= now - heartbeat <= 90:
        return {**evidence, "status": "unverified", "halted": None}
    return {**evidence, "status": "observed", "halted": False,
            "monitor_observed_at": heartbeat}


def compare_observations(local: dict, remote: dict) -> dict:
    left, right = local.get("halted"), remote.get("halted")
    known = (
        local.get("status") == remote.get("status") == "observed"
        and type(left) is bool and type(right) is bool
    )
    comparison = ("match" if left == right else "divergent") if known else "not_reported"
    return {
        "version": "1.0",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "python_guardian": local,
        "worker": remote,
        "guardian_comparison": comparison,
        "guardian_comparison_scope": "global_halt_observations_only",
        "shared_clearance_verified": False,
        "guardian_authority_unified": False,
        "signal_synchronization": "not_reported",
        "portfolio_reconciliation": "not_reported",
        "execution_authorized": False,
        "provider_mutation_allowed": False,
    }


async def runtime_comparison() -> dict:
    remote = await fetch_worker_observation()
    return compare_observations(local_guardian_observation(time.time()), remote)
