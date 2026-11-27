"""Common read-only observation classifier for Python signal routes."""
from __future__ import annotations

import math
import time
from typing import Optional

from backend.logic.signal_engine import SignalRecord
from backend.services.signal_service.service import get_cached_signal


def read_observation(symbol: str, now: Optional[int] = None) -> tuple[Optional[SignalRecord], str, dict]:
    """Read the running candle cache without recomputing or dispatching."""
    symbol = symbol.strip().upper()
    if now is None:
        now = int(time.time())
    record = get_cached_signal(symbol)
    clock = {"status": "not_reported", "kind": None, "timestamp_ms": None,
             "trade_event_time_verified": False}
    if record is None:
        return None, "not_reported", clock
    metadata = record.metadata or {}
    if not isinstance(metadata, dict):
        return record, "unverified", clock
    stamp = metadata.get("provider_timestamp_ms")
    kind = metadata.get("provider_timestamp_kind")
    if metadata.get("price_source") == "bitget" and kind == "bitget_ticker_current_time" and type(stamp) is int:
        clock.update(kind=kind, timestamp_ms=stamp,
                     status="current" if -999 <= now * 1000 - stamp <= 60000 else "outside_window")
    if record.strategy_id in {"error", "no_data", "insufficient_data"}:
        return record, "unavailable", clock
    if (
        record.symbol != symbol
        or record.side not in {"BUY", "SELL", "FLAT"}
        or type(record.confidence) not in {int, float}
        or not math.isfinite(record.confidence)
        or not 0 <= record.confidence <= 1
        or type(record.created_at) is not int
        or type(record.valid_until) is not int
    ):
        return record, "unverified", clock
    if not record.created_at <= now < record.valid_until:
        return record, "expired", clock
    if metadata.get("prediction_input_status") != "validated_observations":
        return record, "unverified", clock
    observed = metadata.get("price_observed_at")
    if type(observed) is not int or not 0 <= now - observed <= 60:
        return record, "expired", clock
    if metadata.get("candle_provenance") != "adapter_attributed_batch":
        return record, "unverified", clock
    candle_time = metadata.get("candle_observed_at")
    if type(candle_time) is not int or not 0 <= now - candle_time <= 75:
        return record, "expired", clock
    return record, "available", clock
