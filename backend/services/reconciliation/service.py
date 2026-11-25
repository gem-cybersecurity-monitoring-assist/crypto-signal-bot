# backend/services/reconciliation/service.py
"""
PHASE 11 — Reconciliation service.

Periodically records local P&L observations and detects simple balance drift.
This diagnostic is not authoritative ledger or cross-runtime reconciliation.

Runs on a timed loop and saves ReconciliationReport to DB.
Flags discrepancies without auto-correcting — flags require
operator review before any state mutation.

Rules:
  - One authoritative persistence path (Rule 6)
  - No competing truth stores
  - File-backed truth not authoritative in production
  - Discrepancy detected = log + flag, never silent

Protected files: none accessed here.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import asdict, dataclass
import math
from typing import Optional

from backend.config.loader import get_exchange_config

log = logging.getLogger(__name__)

_loop_task: Optional[asyncio.Task] = None
_loop_running: bool = False
_last_report: Optional[dict] = None

RECONCILE_INTERVAL_SECONDS = 300   # every 5 minutes


@dataclass
class ReconciliationResult:
    mode:                  str
    usdt_balance:          float
    total_realized_pnl:    float
    total_unrealized_pnl:  float
    open_lots_count:       int
    trade_count:           int
    discrepancy_detected:  bool
    discrepancy_detail:    Optional[str]
    created_at:            int


async def run_reconciliation() -> ReconciliationResult:
    """
    Execute one reconciliation cycle.

    Steps:
      1. Read current P&L state from engine/pnl.py
      2. Compare recent successful local observation
      3. Detect simple balance drift
      4. Persist diagnostic evidence if database is available
      5. Return result

    Scope: balance change without a change in trade count.
    Order-level and cross-runtime accounting remain unverified.
    """
    from backend.engine.pnl import (
        get_usdt_balance,
        get_pnl_summary,
        get_all_lots,
    )

    now = int(time.time())
    cfg = get_exchange_config()

    global _last_report

    # Collect current state
    try:
        pnl = await get_pnl_summary()
        balance = float(get_usdt_balance())
        lots = get_all_lots()
        open_lots_count = sum(len(v) for v in lots.values())
        unrealized = float(pnl.total_unrealized_pnl)
        realized   = float(pnl.total_realized_pnl)
        trades     = pnl.trade_count
        if not all(math.isfinite(value) for value in (balance, unrealized, realized)):
            raise ValueError("Non-finite P&L observation")
        if type(trades) is not int or trades < 0:
            raise ValueError("Invalid trade count")
    except Exception:
        log.error("[reconciliation] Failed to read P&L state")
        _last_report = {
            "mode": cfg.mode, "created_at": now, "observation_status": "unavailable",
            "persistence_status": "not_written", "discrepancy_detected": True,
            "discrepancy_detail": "P&L state read failure",
            "usdt_balance": None, "total_realized_pnl": None,
            "total_unrealized_pnl": None, "trade_count": None, "open_lots_count": None,
        }
        return ReconciliationResult(
            mode=cfg.mode, usdt_balance=0.0,
            total_realized_pnl=0.0, total_unrealized_pnl=0.0,
            open_lots_count=0, trade_count=0,
            discrepancy_detected=True,
            discrepancy_detail="P&L state read failure",
            created_at=now,
        )

    discrepancy_detected = False
    discrepancy_detail: Optional[str] = None

    # Compare with last known report (simple drift check)
    if (
        _last_report
        and _last_report.get("mode") == cfg.mode
        and _last_report.get("observation_status") == "observed"
        and 0 <= now - _last_report["created_at"] <= RECONCILE_INTERVAL_SECONDS * 2
    ):
        last_balance = _last_report.get("usdt_balance", balance)
        drift = abs(balance - last_balance)
        # Flag if balance changed with no trades since last reconciliation
        last_trades = _last_report.get("trade_count", trades)
        if drift > 0.01 and trades == last_trades:
            discrepancy_detected = True
            discrepancy_detail = (
                f"Balance drift detected: "
                f"last={last_balance:.4f} current={balance:.4f} "
                f"delta={drift:.4f} with no new trades"
            )
            log.warning("[reconciliation] %s", discrepancy_detail)

    result = ReconciliationResult(
        mode=cfg.mode,
        usdt_balance=balance,
        total_realized_pnl=realized,
        total_unrealized_pnl=unrealized,
        open_lots_count=open_lots_count,
        trade_count=trades,
        discrepancy_detected=discrepancy_detected,
        discrepancy_detail=discrepancy_detail,
        created_at=now,
    )

    # Persist diagnostic evidence through the existing report table. A failed
    # write is explicit; never claim that the portfolio ledger has reconciled.
    report = {
        **asdict(result),
        "observation_status": "observed",
        "persistence_status": "pending",
    }
    _last_report = report
    try:
        await _persist_report(result)
        report["persistence_status"] = "committed"
    except Exception:
        report["persistence_status"] = "unavailable"
        log.warning("[reconciliation] Diagnostic report persistence unavailable")

    if discrepancy_detected:
        log.warning("[reconciliation] Discrepancy: %s", discrepancy_detail)
    else:
        log.info("[reconciliation] No local balance drift detected — balance=%.4f realized=%.4f lots=%d",
                 balance, realized, open_lots_count)

    return result


async def _persist_report(result: ReconciliationResult) -> None:
    from backend.db.session import get_session
    from backend.db.models import ReconciliationReport
    from backend.db.repositories.base import ReconciliationRepository

    async with get_session() as session:
        await ReconciliationRepository(session).save(ReconciliationReport(**asdict(result)))
        await session.commit()


async def get_latest_report() -> Optional[dict]:
    """Return the current diagnostic or explicitly historical persisted evidence."""
    if _last_report is not None:
        return dict(_last_report)
    from backend.db.session import get_session
    from backend.db.models import ReconciliationReport
    from sqlalchemy import select

    try:
        mode = get_exchange_config().mode
        async with get_session() as session:
            row = (await session.execute(
                select(ReconciliationReport)
                .where(ReconciliationReport.mode == mode)
                .order_by(ReconciliationReport.created_at.desc(), ReconciliationReport.id.desc())
                .limit(1)
            )).scalar_one_or_none()
            if row is None:
                return None
            return {
                **{key: getattr(row, key) for key in ReconciliationResult.__dataclass_fields__},
                "observation_status": "historical",
                "persistence_status": "committed",
            }
    except Exception:
        return None


async def _reconciliation_loop() -> None:
    global _loop_running
    _loop_running = True
    log.info("[reconciliation] Loop started.")

    while _loop_running:
        try:
            await run_reconciliation()
        except Exception as exc:
            log.error("[reconciliation] Loop error: %s", exc)
        await asyncio.sleep(RECONCILE_INTERVAL_SECONDS)

    _loop_running = False
    log.info("[reconciliation] Loop stopped.")


async def _owned_reconciliation_loop() -> None:
    global _loop_running
    try:
        await _reconciliation_loop()
    finally:
        _loop_running = False


async def start_reconciliation() -> None:
    global _loop_task, _loop_running
    if _loop_task is None or _loop_task.done():
        _loop_running = True
        _loop_task = asyncio.create_task(_owned_reconciliation_loop(), name="reconciliation")


async def stop_reconciliation() -> None:
    global _loop_running, _loop_task
    _loop_running = False
    task = _loop_task
    if task is None:
        return
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    finally:
        if _loop_task is task:
            _loop_task = None
