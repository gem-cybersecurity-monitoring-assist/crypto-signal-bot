"""Read-only cross-runtime signal history diagnostic.

The dedicated secret has no trade or general operator permission. A persisted
Worker row is not a provider event, and comparison is not synchronization.
"""
from __future__ import annotations

import asyncio
import json
import math
import os
import re
import time

import httpx

from backend.services.signal_service.observation import read_observation

URL = "https://crypto-signal-bot-api.analyzer-d94.workers.dev/v2/signals/observation"
SYMBOL = re.compile(r"[A-Z0-9]{2,12}USDT", re.ASCII)
MAX_BYTES = 8192


def parse_worker_observation(payload: object, asset: str, now_ms: int) -> dict:
    unknown = {"status": "unverified", "observation": None}
    if not isinstance(payload, dict):
        return unknown
    if (payload.get("version") != "1.0"
            or payload.get("source") != "worker_d1_signal_history"
            or payload.get("symbol") != asset
            or any(payload.get(key) is not False for key in
                   ("event_time_verified", "sequence_verified", "execution_authorized"))):
        return unknown
    observed = payload.get("observed_at_ms")
    if type(observed) is not int or not -2000 <= now_ms - observed <= 30000:
        return {"status": "expired", "observation": None}
    status = payload.get("status")
    row = payload.get("observation")
    if status in ("not_reported", "unverified") and row is None:
        return {"status": status, "observation": None}
    if status != "historical" or not isinstance(row, dict):
        return unknown
    row_id, timestamp = row.get("row_id"), row.get("recorded_at_ms")
    confidence, timeframe = row.get("confidence"), row.get("timeframe")
    if (type(row_id) is not int or not 1 <= row_id <= 9007199254740991
            or row.get("id") != f"signal:{asset}:{row_id}"
            or type(timestamp) is not int or not 0 <= timestamp <= observed
            or row.get("side") not in ("BUY", "SELL", "HOLD", "FLAT")
            or type(confidence) not in (int, float) or not 0 <= confidence <= 1
            or not math.isfinite(confidence)
            or not isinstance(timeframe, str) or not re.fullmatch(r"[1-9][0-9]{0,2}[mhdw]", timeframe)):
        return unknown
    return {"status": "historical", "observation": {
        "id": row["id"], "row_id": row_id, "recorded_at_ms": timestamp,
        "side": row["side"], "confidence": confidence, "timeframe": timeframe,
    }}


async def fetch_worker_signal(asset: str) -> dict:
    if not re.fullmatch(r"[A-Z0-9]{2,12}", asset):
        return {"status": "invalid_symbol", "observation": None}
    key = os.getenv("SIGNAL_OBSERVATION_READ_KEY", "")
    if not 32 <= len(key) <= 256 or not key.isascii() or not key.isprintable():
        return {"status": "not_configured", "observation": None}
    try:
        async with asyncio.timeout(5):
            async with httpx.AsyncClient(timeout=4, follow_redirects=False, trust_env=False,
                headers={"Accept": "application/json", "Accept-Encoding": "identity",
                         "X-Signal-Observation-Key": key}) as client:
                async with client.stream("GET", URL, params={"symbol": asset}) as response:
                    if response.status_code == 401:
                        return {"status": "authentication_required", "observation": None}
                    if (response.status_code != 200
                            or response.headers.get("content-type", "").split(";")[0].strip().lower() != "application/json"
                            or response.headers.get("content-encoding", "identity").lower() != "identity"):
                        raise ValueError("Unexpected observation response")
                    data = bytearray()
                    async for chunk in response.aiter_raw(chunk_size=4096):
                        if len(data) + len(chunk) > MAX_BYTES:
                            raise ValueError("Observation exceeds limit")
                        data.extend(chunk)
        return parse_worker_observation(json.loads(data), asset, int(time.time() * 1000))
    except (TimeoutError, httpx.HTTPError, ValueError, UnicodeError, RecursionError):
        return {"status": "unavailable", "observation": None}


async def compare_signal_history(symbol: str) -> dict:
    remote = await fetch_worker_signal(symbol.removesuffix("USDT"))
    record, status, _ = read_observation(symbol)
    local = {"status": status, "observation": None}
    if record is not None and status == "available":
        local["observation"] = {"id": record.id, "side": record.side,
                                "timeframe": record.timeframe, "recorded_at_ms": record.created_at * 1000}
    return {"version": "1.0", "symbol": symbol, "python": local, "worker": remote,
            "identity_scope": "independent_namespaces", "shared_event_verified": False,
            "sequence_verified": False, "signal_synchronization": "not_verified",
            "execution_authorized": False}
