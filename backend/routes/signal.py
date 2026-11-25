"""Legacy Python signal read model backed by the running candle service.

This is a research observation, not an executable forecast or Worker sync.
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Query
from pydantic import BaseModel

from backend.services.signal_service.observation import read_observation
from backend.services.signal_service.service import get_signal_service_status

router = APIRouter(tags=["signals"])
_SIDE_TO_DIRECTION = {"BUY": "UP", "SELL": "DOWN", "FLAT": "NEUTRAL"}


class SignalResponse(BaseModel):
    symbol: str
    direction: str
    side: str
    confidence: float
    regime: str
    horizon: int
    available: bool
    source: str
    computed_at: int
    reasoning: Optional[str] = None
    message: Optional[str] = None
    signal_id: Optional[str] = None
    valid_until: Optional[int] = None
    readiness_status: str
    confidence_scale: str = "percent"
    execution_authorized: bool = False
    worker_synchronized: bool = False
    forecast_horizon_verified: bool = False
    regime_verified: bool = False


class PredictionStatusResponse(BaseModel):
    running: bool
    cached_symbols: list[str]
    tracked_symbols: int
    source: str = "python_signal_service_cache"
    worker_synchronized: bool = False


@router.get(
    "/signal/latest", response_model=SignalResponse,
    summary="Latest observed Python research signal",
    description="Reads the same candle cache as prediction readiness. Never recomputes or authorizes an order.",
)
async def get_signal_latest(
    symbol: Optional[str] = Query(None, description="Backend symbol, e.g. BTCUSDT"),
) -> SignalResponse:
    symbol = (symbol or "").strip().upper()
    record, status, _ = read_observation(symbol) if symbol else (None, "not_reported", {})
    available = status == "available" and record is not None
    direction = _SIDE_TO_DIRECTION[record.side] if available else "NEUTRAL"
    # No classified regime or forecast horizon is produced by this engine.
    # Do not reinterpret cache TTL as a prediction horizon.
    return SignalResponse(
        symbol=symbol, direction=direction,
        side=record.side if available and record.side != "FLAT" else "NEUTRAL",
        confidence=record.confidence * 100 if available else 0.0,
        regime="UNKNOWN", horizon=0,
        available=available, source="python_signal_service_cache" if available else "unavailable",
        computed_at=record.created_at if available else 0,
        message=None if available else (
            f"Signal observation {status}" if symbol else "Symbol parameter required. Use /signal/latest?symbol=BTCUSDT"
        ),
        signal_id=record.id if record else None,
        valid_until=record.valid_until if available else None,
        readiness_status=status,
    )


@router.get("/prediction/status", response_model=PredictionStatusResponse, summary="Running analytical signal service status")
async def get_prediction_status_route() -> PredictionStatusResponse:
    return PredictionStatusResponse(**get_signal_service_status())
