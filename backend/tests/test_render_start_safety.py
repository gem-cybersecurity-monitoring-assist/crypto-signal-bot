from __future__ import annotations

import importlib.util
import os
import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch


REPO_ROOT = Path(__file__).resolve().parents[2]


def run_startup(filename: str, environment: dict[str, str]) -> dict[str, str]:
    observed: dict[str, str] = {}

    def capture_startup_environment(command: list[str]) -> int:
        observed.update(os.environ)
        return 0

    with patch.dict(os.environ, environment, clear=True):
        with patch.object(subprocess, "call", side_effect=capture_startup_environment):
            spec = importlib.util.spec_from_file_location(
                f"startup_test_{filename.replace('.', '_')}", REPO_ROOT / filename
            )
            if spec is None or spec.loader is None:
                raise AssertionError(f"Unable to load {filename}")
            module = importlib.util.module_from_spec(spec)
            try:
                spec.loader.exec_module(module)
            except SystemExit as result:
                if result.code != 0:
                    raise
            else:
                raise AssertionError(f"{filename} did not exit after mocked startup")
    return observed


class SeparateStartupEnvironmentTests(unittest.TestCase):
    def test_testnet_startup_overrides_stale_live_host_variables(self):
        observed = run_startup(
            "render_start.py",
            {
                "EXCHANGE_MODE": "live",
                "TRADING_MODE": "live",
                "NETWORK": "mainnet",
                "ALLOW_MAINNET": "true",
                "LIVE_TRADING_ENABLED": "true",
                "WITHDRAWALS_ENABLED": "true",
            },
        )
        self.assertEqual(observed["EXCHANGE_MODE"], "paper")
        self.assertEqual(observed["TRADING_MODE"], "paper")
        self.assertEqual(observed["NETWORK"], "testnet")
        self.assertEqual(observed["ALLOW_MAINNET"], "false")
        self.assertEqual(observed["LIVE_TRADING_ENABLED"], "false")
        self.assertEqual(observed["WITHDRAWALS_ENABLED"], "false")
        self.assertEqual(observed["PAPER_STARTING_BALANCE_USDT"], "10000")

    def test_mainnet_startup_configuration_is_preserved_separately(self):
        observed = run_startup("render_start_mainnet.py", {})
        self.assertEqual(observed["EXCHANGE_MODE"], "live")
        self.assertEqual(observed["TRADING_MODE"], "live")
        self.assertEqual(observed["NETWORK"], "mainnet")
        self.assertEqual(observed["ALLOW_MAINNET"], "true")
        self.assertEqual(observed["LIVE_CAPITAL_CAP_USDT"], "100")
        self.assertEqual(observed["EXCHANGE"], "bitget")

    def test_procfiles_select_distinct_startup_paths(self):
        self.assertEqual(
            (REPO_ROOT / "Procfile").read_text(encoding="utf-8").strip(),
            "web: python render_start.py",
        )
        self.assertEqual(
            (REPO_ROOT / "Procfile.mainnet").read_text(encoding="utf-8").strip(),
            "web: python render_start_mainnet.py",
        )


if __name__ == "__main__":
    unittest.main()
