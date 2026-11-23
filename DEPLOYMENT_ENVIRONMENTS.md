# Separate Testnet and Mainnet Startup Paths

## Current certification path: Testnet / paper

The default `Procfile` starts `render_start.py`. This path forcibly sets paper mode, testnet, `ALLOW_MAINNET=false`, `LIVE_TRADING_ENABLED=false`, and `WITHDRAWALS_ENABLED=false`, even if a host has stale live-mode variables. The paper starting balance defaults to 10,000 USDT.

Use this path for the current testnet certification and paper-trade validation.

## Preserved mainnet path

The prior live-mode startup configuration is retained in `render_start_mainnet.py`, with its Bitget environment-variable names, mainnet selection, $100 capital cap, executor sizing, Guardian thresholds, and Telegram alert settings preserved.

`Procfile.mainnet` explicitly selects that startup module. It is a separate deployment/start-command option; it is not selected by the default Procfile and this change does not deploy or activate it.

Do not switch a service to `Procfile.mainnet` or `python render_start_mainnet.py` until the testnet flow has been fully validated and the owner separately authorizes mainnet activation. Keep live credentials in the hosting provider's secret store; never commit them.

## Verification

Run the startup-path regression tests with:

```powershell
python -m unittest backend.tests.test_render_start_safety -v
```

The tests exercise both startup scripts with subprocess startup mocked, verify that stale live variables cannot leak into the default testnet path, verify the retained mainnet configuration, and confirm the two Procfiles point to distinct modules.
