from __future__ import annotations

import importlib.util
import os
import subprocess
from pathlib import Path

import pytest


def test_hosted_startup_forces_paper_testnet_even_with_stale_live_environment(monkeypatch):
    """Render/Railway must not inherit a stale live/mainnet environment."""
    repo_root = Path(__file__).resolve().parents[2]
    startup_path = repo_root / "render_start.py"

    for name, value in {
        "EXCHANGE_MODE": "live",
        "TRADING_MODE": "live",
        "NETWORK": "mainnet",
        "ALLOW_MAINNET": "true",
        "LIVE_TRADING_ENABLED": "true",
        "WITHDRAWALS_ENABLED": "true",
    }.items():
        monkeypatch.setenv(name, value)

    observed: dict[str, str] = {}

    def capture_startup_environment(command: list[str]) -> int:
        observed.update(os.environ)
        return 0

    monkeypatch.setattr(subprocess, "call", capture_startup_environment)

    spec = importlib.util.spec_from_file_location("render_start_safety_test", startup_path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)

    with pytest.raises(SystemExit) as result:
        spec.loader.exec_module(module)

    assert result.value.code == 0
    assert observed["EXCHANGE_MODE"] == "paper"
    assert observed["TRADING_MODE"] == "paper"
    assert observed["NETWORK"] == "testnet"
    assert observed["ALLOW_MAINNET"] == "false"
    assert observed["LIVE_TRADING_ENABLED"] == "false"
    assert observed["WITHDRAWALS_ENABLED"] == "false"
    assert observed["PAPER_STARTING_BALANCE_USDT"] == "10000"
