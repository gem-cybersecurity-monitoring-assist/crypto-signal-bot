"""Routes for the existing paper earnings ledger API."""
from fastapi import APIRouter, Depends, Query

from backend.dependencies import require_auth
from backend.logic import rate_limit
from backend.logic.earnings import get_history, get_summary, reset_earnings

router = APIRouter(prefix="/earnings")


@router.get("/summary", dependencies=[Depends(rate_limit.rate_limit)])
def get_earnings_summary_api():
    return get_summary()


@router.get("/history", dependencies=[Depends(rate_limit.rate_limit)])
def get_earnings_history_api(symbol: str | None = Query(None), limit: int = Query(100, ge=1, le=500)):
    return {"trades": get_history(symbol=symbol, limit=limit)}


@router.post("/reset")
def reset_earnings_ledger_api(_: None = Depends(require_auth)):
    reset_earnings()
    return {"status": "ok", "message": "Earnings ledger cleared"}
