from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch


REPO_ROOT = Path(__file__).resolve().parents[2]


class RenderStartSafetyTests(unittest.TestCase):
    def test_hosted_startup_forces_paper_testnet_even_with_stale_live_environment(self):
        """Render/Railway must not inherit a stale live/mainnet environment."""
        startup_path = REPO_ROOT / "render_start.py"
        hostile_environment = {
            "EXCHANGE_MODE": "live",
            "TRADING_MODE": "live",
            "NETWORK": "mainnet",
            "ALLOW_MAINNET": "true",
            "LIVE_TRADING_ENABLED": "true",
            "WITHDRAWALS_ENABLED": "true",
        }
        observed: dict[str, str] = {}

        def capture_startup_environment(command: list[str]) -> int:
            observed.update(os.environ)
            return 0

        with patch.dict(os.environ, hostile_environment, clear=False):
            with patch.object(subprocess, "call", side_effect=capture_startup_environment):
                spec = importlib.util.spec_from_file_location("render_start_safety_test", startup_path)
                self.assertIsNotNone(spec)
                self.assertIsNotNone(spec.loader)
                module = importlib.util.module_from_spec(spec)
                with self.assertRaises(SystemExit) as result:
                    spec.loader.exec_module(module)

        self.assertEqual(result.exception.code, 0)
        self.assertEqual(observed["EXCHANGE_MODE"], "paper")
        self.assertEqual(observed["TRADING_MODE"], "paper")
        self.assertEqual(observed["NETWORK"], "testnet")
        self.assertEqual(observed["ALLOW_MAINNET"], "false")
        self.assertEqual(observed["LIVE_TRADING_ENABLED"], "false")
        self.assertEqual(observed["WITHDRAWALS_ENABLED"], "false")
        self.assertEqual(observed["PAPER_STARTING_BALANCE_USDT"], "10000")

    def test_railway_build_and_healthcheck_use_the_safe_python_service(self):
        config = json.loads((REPO_ROOT / "railway.json").read_text(encoding="utf-8"))
        self.assertEqual(config["build"]["builder"], "RAILPACK")
        self.assertIn("backend/requirements.txt", config["build"]["buildCommand"])
        self.assertEqual(config["deploy"]["startCommand"], "python render_start.py")
        self.assertEqual(config["deploy"]["healthcheckPath"], "/healthz")
        self.assertEqual(config["deploy"]["restartPolicyType"], "ON_FAILURE")


if __name__ == "__main__":
    unittest.main()
