# backend/services/guardian_bot/monitor.py
"""
Guardian Monitor — background loop bridging Portfolio → Guardian.

Every MONITOR_INTERVAL seconds:
  1. Read total equity (cash + unrealized P&L) from portfolio service
  2. Compute drawdown vs peak_equity → feed update_drawdown() → auto kill-switch if breached
  3. Compute today's realized loss → feed update_daily_loss()
  4. Record heartbeat
"""
from __future__ import annotations

import asyncio
import logging
import time

log = logging.getLogger(__name__)

MONITOR_INTERVAL = 30  # seconds
_monitor_task: asyncio.Task | None = None
_last_successful_cycle_at: int | None = None


async def _monitor_loop() -> None:
    global _last_successful_cycle_at
    from backend.services.guardian_bot.service import (
        update_drawdown, update_daily_loss, record_heartbeat,
    )
    import backend.services.portfolio.service as port_svc

    log.info("[guardian_monitor] started (interval=%ds)", MONITOR_INTERVAL)
    while True:
        await asyncio.sleep(MONITOR_INTERVAL)
        try:
            # Use marked equity (cash + market value), not just cash.
            # This prevents false drawdown triggers when capital is deployed into positions.
            equity = await port_svc._compute_equity()
            peak   = port_svc._peak_equity
            dd     = float((peak - equity) / peak * 100) if float(peak) > 0 else 0.0

            now       = int(time.time())
            day_start = now - (now % 86400)
            daily_loss_pct = abs(min(
                sum(float(t.realized_pnl)
                    for t in port_svc._trades
                    if t.realized_pnl is not None and t.executed_at >= day_start),
                0.0,
            )) / float(port_svc.STARTING_CASH) * 100

            await update_drawdown(dd)
            await update_daily_loss(daily_loss_pct)
            record_heartbeat()
            _last_successful_cycle_at = int(time.time())

            log.debug("[guardian_monitor] equity=%.2f peak=%.2f dd=%.2f%% daily_loss=%.2f%%",
                      equity, peak, dd, daily_loss_pct)
        except Exception as exc:
            log.warning("[guardian_monitor] error: %s", exc)


async def start_guardian_monitor(app) -> None:
    global _monitor_task, _last_successful_cycle_at
    if _monitor_task is None or _monitor_task.done():
        _last_successful_cycle_at = None
        _monitor_task = asyncio.create_task(_monitor_loop(), name="guardian_monitor")


async def stop_guardian_monitor() -> None:
    global _monitor_task, _last_successful_cycle_at
    _last_successful_cycle_at = None
    task = _monitor_task
    if task is None:
        return
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    finally:
        if _monitor_task is task:
            _monitor_task = None
