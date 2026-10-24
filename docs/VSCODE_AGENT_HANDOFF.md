# Handoff for the VS Code Claude agent (2026-10-24)

Paste the block below into the Claude agent in VS Code, in this repository on Windows.

```text
Context: a cloud session audited this repo on 2026-10-24. Findings are in
docs/PROJECT_STATUS_2026-10-24.md (PR #253). Summary:
- main @ 70ec4e3 passes every root and Worker gate (lint, typecheck, 51/51 frontend
  tests, build, Worker tests, paper-safety, migrations).
- Vercel production serves main. Cloudflare Worker crypto-signal-bot-api is live
  (crons firing, D1 snapshots current, KV/R2 bindings match wrangler.toml).
- Worker was last deployed 2026-10-04; deployed bundle vs main is unconfirmed.
- The Python bot engine (backend/: signal engine, surge scanner, signal executor,
  risk gate, Guardian bot, coordinator) is set up for Render/Railway; whether it is
  running is unconfirmed.

Do these in order, in PowerShell, and report the output of each step. Stop and ask
me before any step that deploys, changes secrets, or touches live/mainnet settings.

1. Sync and install
   git checkout main; git pull origin main
   npm ci; Push-Location worker; npm ci; Pop-Location

2. Confirm the deployed Worker and Vercel match main
   npm run verify:deployment
   If it reports drift, tell me; do not deploy without my OK. The deploy path is the
   manual GitHub workflow .github/workflows/deploy.yml with deploy_worker=true.

3. Run and test the Python bot engine locally in paper mode
   py -3.11 -m venv .venv; .\.venv\Scripts\Activate.ps1
   python -m pip install -r backend/requirements.txt
   python -m pytest backend/tests -q
   $env:TRADING_MODE="paper"; $env:EXCHANGE_MODE="paper"; $env:NETWORK="testnet"
   $env:ALLOW_MAINNET="false"; $env:PAPER_USE_LIVE_MARKET_DATA="true"
   python -m uvicorn backend.app:app --host 127.0.0.1 --port 8000
   In a second terminal: Invoke-RestMethod http://127.0.0.1:8000/health
   and /signal/latest, /guardian/status, /positions. Confirm the log shows
   "All background services registered." and the signal executor and surge scanner
   started.

4. Report which hosted copy of the Python engine (Render service
   crypto-signal-bot-backend, or Railway project zucchini-wisdom) is the one we keep,
   and whether its /healthz is green.

Rules (from CLAUDE.md and AGENTS.md, still in force):
- Paper/testnet only. Do not set ALLOW_MAINNET, TRADING_MODE=live,
  LIVE_TRADING_ENABLED or WITHDRAWALS_ENABLED to true, and do not remove the 403
  live/withdraw routes or the verify:paper-safety checks.
- Any move toward real money is a separate, owner-authorized plan
  (docs/VSCODE_AGENT_HANDOFF.md, "Path to real money"), done as reviewed PRs.
```

## Path to real money (owner decision, not yet authorized)

The repository's operating rules forbid live trading today. Enabling it safely is a staged
project, not a switch:

| Stage | What happens | Exit criteria |
| --- | --- | --- |
| 0. Paper, fully running | Cloudflare dashboard plus Python bot engine trading pretend money | 30 days and 100 paper trades; drawdown, win rate and after-fee results reviewed |
| 1. Exchange testnet/demo | Bitget demo account via API; PR #251 (read-only V3 client) reviewed and merged | Orders, fills and reconciliation match the exchange for 2+ weeks |
| 2. Owner authorization | Owner updates CLAUDE.md/AGENTS.md to allow a capped live release; draft PRs #232–#250 reviewed | Independent review signed off |
| 3. Small capped mainnet | Trade-only API key (withdraw permission off, IP allow-listed), hard per-order and per-day limits, Guardian armed | Weekly review; any breach halts trading |

Withdrawals stay disabled at every stage: the exchange API key must not have withdraw
permission. BTCC (primary exchange) is blocked on its provider contract
(`docs/BTCC_PROVIDER_CONTRACT_STATUS.md`), so Bitget would be the first venue.
