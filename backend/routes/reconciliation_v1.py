"""Reconciliation and exchange validation endpoints."""

import time

from fastapi import APIRouter, Depends

from backend import app_state
from backend.logic import rate_limit

router = APIRouter(dependencies=[Depends(rate_limit.rate_limit)])


@router.get("/reconciliation/status")
async def reconciliation_status_api():
    from backend.services.reconciliation.service import get_latest_report
    report = await get_latest_report()
    if report is None:
        return {"status": "no_report", "message": "Reconciliation has not run yet."}
    state = report.get("observation_status")
    created_at = report.get("created_at")
    if state == "unavailable":
        status = "unavailable"
    elif state == "historical":
        status = "historical"
    elif state != "observed" or type(created_at) is not int:
        status = "unverified"
    elif not 0 <= time.time() - created_at <= 600:
        status = "expired"
    else:
        status = "discrepancy" if report.get("discrepancy_detected") is True else "observed"
    return {"status": status, "report": report, "scope": "local_pnl_diagnostic",
            "ledger_reconciled": False, "worker_reconciled": False}


@router.get("/reconciliation/exchange")
def exchange_reconciliation_api():
    from backend.services.exchange_reconciler import reconcile_against_exchange
    result = reconcile_against_exchange(
        adapter=app_state.adapter(),
        local_balances=dict(app_state.portfolio().balances),
    )
    return result.to_dict()
