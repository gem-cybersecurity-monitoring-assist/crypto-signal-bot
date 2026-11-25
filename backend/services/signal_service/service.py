# backend/services/signal_service/service.py
"""
Signal service — orchestrates candle fetching, signal evaluation,
DB persistence, and in-process caching.
"""
from __future__ import annotations

import asyncio
import json
import logging
import math
import time
from typing import Dict, List, Optional

from backend.logic.signal_engine import SignalRecord, evaluate_symbol
from backend.services.market_data.service import get_price

log = logging.getLogger(__name__)

_SYMBOLS: List[str] = [
    "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "ADAUSDT",
    "XRPUSDT", "DOGEUSDT", "DOTUSDT", "AVAXUSDT", "LINKUSDT",
]
_TIMEFRAME     = "1h"
_CANDLE_LIMIT  = 220
_EVAL_INTERVAL = 60
_TTL_SECONDS   = 900

_signal_cache: Dict[str, SignalRecord] = {}
_last_eval:    Dict[str, float]        = {}
_running = False
_eval_task: Optional[asyncio.Task] = None


# Module-level singleton for OHLCV fetching
_ohlcv_adapter = None
_ohlcv_adapter_lock = None


def _get_ohlcv_lock():
    global _ohlcv_adapter_lock
    if _ohlcv_adapter_lock is None:
        _ohlcv_adapter_lock = asyncio.Lock()
    return _ohlcv_adapter_lock


async def _get_ohlcv_adapter():
    """
    Return a BinanceUsOhlcvAdapter singleton.
    Falls back to the generic market-data adapter chain on import failure.
    """
    global _ohlcv_adapter
    async with _get_ohlcv_lock():
        if _ohlcv_adapter is None:
            try:
                from backend.adapters.exchanges.binance_us_ohlcv import BinanceUsOhlcvAdapter
                _ohlcv_adapter = BinanceUsOhlcvAdapter(paper=True)
                log.info("[signal_service] OHLCV adapter: BinanceUsOhlcvAdapter")
            except Exception as exc:
                log.warning("[signal_service] BinanceUsOhlcvAdapter unavailable (%s) — using generic chain", exc)
                _ohlcv_adapter = None
    return _ohlcv_adapter


async def _fetch_candles(symbol: str, limit: int = _CANDLE_LIMIT, *, require_provenance: bool = False):
    """
    Fetch OHLCV candles with a 3-tier priority chain:
      0. IngestionPipeline ring buffer  — zero-latency in-memory path (preferred)
      1. BinanceUsOhlcvAdapter          — live adapter (buffer cold or insufficient depth)
      2. Generic market-data adapter chain — final fallback

    Tier 0 is the hot path. When the ingestion pipeline is running and warmed up
    it eliminates network round-trips entirely from the signal evaluation loop,
    cutting per-evaluation latency from ~500ms to <1ms.
    """
    from backend.services.market_data.ingestion import (
        CANDLE_SOURCES, CandleObservation, get_candle_observation,
    )

    def result(candles, source):
        if not require_provenance:
            return candles
        return CandleObservation(symbol, _TIMEFRAME, source, int(time.time()), tuple(candles))

    # 0. In-memory ring buffer (IngestionPipeline) — zero network cost
    try:
        from backend.services.market_data.ingestion import get_candles_from_buffer
        if require_provenance:
            obs = get_candle_observation(symbol, limit)
            if obs is not None and len(obs.candles) >= 30:
                return obs
            buffered = []
        else:
            buffered = get_candles_from_buffer(symbol, limit)
        if buffered and len(buffered) >= 30:   # at minimum need BB20 warm-up
            log.debug(
                "[signal_service] %s: %d candles from ingestion ring buffer (zero-latency)",
                symbol, len(buffered),
            )
            return buffered
        elif buffered:
            log.debug(
                "[signal_service] %s: ring buffer shallow (%d candles) — falling back to adapter",
                symbol, len(buffered),
            )
    except Exception as exc:
        log.debug("[signal_service] Ingestion ring buffer unavailable for %s: %s", symbol, exc)

    # 1. Try Binance.US dedicated OHLCV adapter
    try:
        adapter = await _get_ohlcv_adapter()
        if adapter is not None:
            candles = await adapter.fetch_ohlcv(symbol, _TIMEFRAME, limit)
            if candles and len(candles) >= 2:
                log.debug("[signal_service] %s: %d candles from BinanceUsOhlcvAdapter",
                          symbol, len(candles))
                if not require_provenance or len(candles) >= 30:
                    return result(candles, "binance_us_ohlcv")
            elif candles:
                log.debug("[signal_service] %s: only %d candles — trying fallback",
                          symbol, len(candles))
    except Exception as exc:
        log.debug("[signal_service] BinanceUsOhlcvAdapter failed for %s: %s — trying fallback", symbol, exc)

    # 2. Fallback: generic adapter chain (CoinGecko synthetic candles)
    try:
        from backend.services.market_data.service import _get_adapters
        adapters = await _get_adapters()
        for adapter in adapters:
            try:
                if require_provenance and adapter.exchange_name not in CANDLE_SOURCES:
                    continue
                candles = await adapter.fetch_ohlcv(symbol, _TIMEFRAME, limit)
                if candles and (not require_provenance or len(candles) >= 30):
                    return result(candles, adapter.exchange_name)
            except Exception:
                continue
    except Exception as exc:
        log.warning("fetch_candles(%s): %s", symbol, exc)
    return None if require_provenance else []


def prediction_input_error(symbol, snapshot, candles, now: int) -> Optional[str]:
    """Validate observed input integrity; not an execution authorization."""
    try:
        if snapshot is None or snapshot.symbol != symbol or snapshot.stale is not False:
            return "price_unavailable_or_stale"
        if snapshot.market_data_mode not in {"live", "paper_live"}:
            return "price_mode_unavailable"
        if snapshot.source not in {"binance", "binance_us_ohlcv", "bitget", "btcc", "coinbase", "coingecko"}:
            return "price_source_unverified"
        if not 0 <= now - snapshot.fetched_at <= 60:
            return "price_observation_expired"
        price = float(snapshot.price)
        if not math.isfinite(price) or price <= 0:
            return "price_invalid"
        if len(candles) < 30 or len(candles) > _CANDLE_LIMIT:
            return "candle_history_insufficient_or_oversized"
        previous = None
        for candle in candles:
            ts = candle.time
            if isinstance(ts, bool) or not isinstance(ts, int) or ts <= 0 or ts > now:
                return "candle_timestamp_invalid"
            if previous is not None and ts - previous != 3600:
                return "candle_sequence_invalid"
            previous = ts
            op, hi, lo, cl, vol = map(float, (candle.open, candle.high, candle.low, candle.close, candle.volume))
            if not all(map(math.isfinite, (op, hi, lo, cl, vol))):
                return "candle_value_invalid"
            if lo <= 0 or vol < 0 or not lo <= min(op, cl) <= max(op, cl) <= hi:
                return "candle_value_invalid"
        if now - previous > 4200:
            return "candle_history_stale"
    except (AttributeError, TypeError, ValueError, OverflowError):
        return "market_input_invalid"
    return None


async def evaluate_signal(symbol: str, strategy: Optional[str] = None) -> SignalRecord:
    requested_strategy = strategy.strip().lower() if isinstance(strategy, str) and strategy.strip() else None
    symbol = symbol.strip().upper()
    from backend.services.market_data.ingestion import CANDLE_SOURCES, CandleObservation, FRESHNESS_WARN_THRESHOLD
    snapshot = None
    observation = None
    try:
        observation = await _fetch_candles(symbol, require_provenance=True)
        snapshot = await get_price(symbol)
    except Exception:
        observation = None

    now = int(time.time())
    valid_observation = (
        isinstance(observation, CandleObservation)
        and observation.symbol == symbol
        and observation.interval == _TIMEFRAME
        and observation.source in CANDLE_SOURCES
        and type(observation.fetched_at) is int
        and 0 <= now - observation.fetched_at <= FRESHNESS_WARN_THRESHOLD
    )
    candles = observation.candles if valid_observation else ()
    input_error = (
        prediction_input_error(symbol, snapshot, candles, now)
        if valid_observation else "candle_provenance_unavailable"
    )
    current_price = float(snapshot.price) if input_error is None else 0.0

    if input_error is not None:
        import uuid
        now = int(time.time())
        metadata = {"reason": input_error, "prediction_input_status": "unavailable"}
        if requested_strategy:
            metadata["requested_strategy"] = requested_strategy
            metadata["strategy_parameter_supported"] = True
        rec = SignalRecord(
            id=str(uuid.uuid4()), symbol=symbol, timeframe=_TIMEFRAME,
            side="FLAT", entry_price=current_price,
            stop_loss=None, take_profit=None,
            confidence=0.0, strategy_id="no_data",
            created_at=now, valid_until=now + _TTL_SECONDS,
            metadata=metadata,
        )
        _signal_cache[symbol] = rec
        return rec

    closes = [float(c.close) for c in candles]
    highs  = [float(c.high)  for c in candles]
    lows   = [float(c.low)   for c in candles]

    record = evaluate_symbol(
        symbol=symbol, timeframe=_TIMEFRAME,
        closes=closes, highs=highs, lows=lows,
        current_price=current_price, signal_ttl_seconds=_TTL_SECONDS,
    )

    record.metadata = dict(record.metadata or {})
    record.metadata["prediction_input_status"] = "validated_observations"
    record.metadata["price_observed_at"] = snapshot.fetched_at
    record.metadata["price_source"] = snapshot.source
    record.metadata["provider_timestamp_ms"] = snapshot.provider_timestamp_ms
    record.metadata["provider_timestamp_kind"] = snapshot.provider_timestamp_kind
    record.metadata["latest_candle_at"] = candles[-1].time
    record.metadata["candle_source"] = observation.source
    record.metadata["candle_observed_at"] = observation.fetched_at
    record.metadata["candle_provenance"] = "adapter_attributed_batch"
    record.metadata["trade_event_time_verified"] = False
    if requested_strategy:
        record.metadata["requested_strategy"] = requested_strategy
        record.metadata["strategy_parameter_supported"] = True
        record.metadata.setdefault("strategy_engine_note", "core engine used existing combined evaluator")

    _signal_cache[symbol] = record
    _last_eval[symbol]    = time.time()
    await _persist_signal(record)

    log.info("[signal] %s → %s  conf=%.2f  strategy=%s",
             symbol, record.side, record.confidence, record.strategy_id)
    return record


async def _persist_signal(record: SignalRecord) -> None:
    try:
        from backend.db.session import get_session
        from backend.db.models import SignalRecord as DBSignal
        async with get_session() as session:
            row = DBSignal(
                id=record.id, symbol=record.symbol, timeframe=record.timeframe,
                side=record.side, entry_price=record.entry_price,
                stop_loss=record.stop_loss, take_profit=record.take_profit,
                confidence=record.confidence, strategy_id=record.strategy_id,
                created_at=record.created_at, valid_until=record.valid_until,
                metadata_json=json.dumps(record.metadata),
            )
            session.add(row)
            await session.commit()
    except Exception as exc:
        log.debug("signal persist error (non-fatal): %s", exc)


def get_cached_signal(symbol: str) -> Optional[SignalRecord]:
    return _signal_cache.get(symbol.upper())


def get_all_cached_signals() -> List[SignalRecord]:
    return list(_signal_cache.values())


def get_signal_service_status() -> dict:
    return {
        "running":         _running,
        "cached_symbols":  list(_signal_cache.keys()),
        "tracked_symbols": len(_SYMBOLS),
        "eval_interval":   _EVAL_INTERVAL,
        "last_eval":       {s: int(t) for s, t in _last_eval.items()},
    }


async def _eval_loop() -> None:
    global _running
    _running = True
    log.info("[signal_service] loop started — %d symbols", len(_SYMBOLS))
    try:
        while _running:
            for symbol in _SYMBOLS:
                try:
                    await evaluate_signal(symbol)
                except Exception as exc:
                    log.warning("[signal_service] %s: %s", symbol, exc)
                await asyncio.sleep(0.5)
            await asyncio.sleep(_EVAL_INTERVAL)
    finally:
        _running = False


async def start_signal_service(app) -> None:
    """Start at most one analytical evaluation task per process."""
    global _eval_task, _running
    if _eval_task is not None and not _eval_task.done():
        return
    _running = True
    _eval_task = asyncio.create_task(_eval_loop(), name="signal_service_evaluation")


async def stop_signal_service() -> None:
    """Await cancellation before persistence services are shut down."""
    global _eval_task, _running
    _running = False
    task = _eval_task
    if task is None:
        return
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    finally:
        if _eval_task is task:
            _eval_task = None
        _signal_cache.clear()
        _last_eval.clear()
