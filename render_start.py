"""Universal safe startup shim — paper/testnet only.

The Procfile is used by Render and Railway. Never let a hosting platform's
missing or stale environment variables silently switch this service to live
trading or mainnet.
"""

from __future__ import annotations

import os
import subprocess
import sys

# Fail closed regardless of stale host-level variables. This Python service is
# paper-only; live execution, mainnet, and withdrawals are not enabled here.
os.environ["EXCHANGE_MODE"] = "paper"
os.environ["TRADING_MODE"] = "paper"  # backend/config/runtime.py reads this
os.environ["NETWORK"] = "testnet"
os.environ["ALLOW_MAINNET"] = "false"
os.environ["LIVE_TRADING_ENABLED"] = "false"
os.environ["WITHDRAWALS_ENABLED"] = "false"

# Paper execution defaults. These do not grant exchange write capability.
os.environ.setdefault("EXCHANGE", "bitget")
os.environ.setdefault("BITGET_API_KEY", "")
os.environ.setdefault("BITGET_API_SECRET", "")
os.environ.setdefault("BITGET_API_PASSPHRASE", "")
os.environ.setdefault("BITGET_PASSPHRASE", "")  # pydantic field name
os.environ.setdefault("PAPER_STARTING_BALANCE_USDT", "10000")
os.environ.setdefault("EXECUTOR_POSITION_PCT", "0.05")
os.environ.setdefault("EXECUTOR_MAX_POSITIONS", "4")
os.environ.setdefault("EXECUTOR_MIN_CONFIDENCE", "0.80")
os.environ.setdefault("EXECUTOR_INTERVAL", "60")

# Guardian thresholds remain conservative in the paper environment.
os.environ.setdefault("GUARDIAN_MAX_DRAWDOWN_PCT", "10")
os.environ.setdefault("GUARDIAN_MAX_DAILY_LOSS_PCT", "5")
os.environ.setdefault("GUARDIAN_MAX_API_ERRORS", "5")
os.environ.setdefault("GUARDIAN_MAX_FAILED_ORDERS", "3")

# Telegram alerts are optional and never required for startup.
os.environ.setdefault("TELEGRAM_ALERTS_ENABLED", "true")
os.environ.setdefault("TELEGRAM_CHANNEL_ID", "-1003368597629")
os.environ.setdefault("TELEGRAM_BOT_TOKEN", "")

# ── Server startup ────────────────────────────────────────────────────────────
PORT = os.getenv("PORT", "10000")

CANDIDATES = [
    "backend.health_wrapper:app",
    "backend.render_entrypoint:app",
    "backend.app:app",
    "main:app",
    "app:app",
]


def _run(target: str) -> int:
    cmd = [
        sys.executable, "-m", "uvicorn", target,
        "--host", "0.0.0.0", "--port", PORT,
    ]
    print(f"[render_start] attempting startup target: {target}", flush=True)
    return subprocess.call(cmd)


for candidate in CANDIDATES:
    code = _run(candidate)
    if code == 0:
        raise SystemExit(0)
    print(f"[render_start] target failed: {candidate} exit={code}", flush=True)

raise SystemExit(1)
