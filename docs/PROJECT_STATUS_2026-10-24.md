# Project Status — 2026-10-24

Consolidated view of every workspace that contributed to Crypto Signal Bot, what is
verifiably done, what remains, and how to start using the service today.

## 1. Sources reviewed

| Source | Access | What it showed |
| --- | --- | --- |
| GitHub `main` (HEAD `70ec4e3`, 2026-10-01) | Full | Merged work through PR #231 plus KV/R2 ops commits |
| GitHub open PRs (#167–#252) | Full | 23 open PRs: 1 Dependabot, 1 ready (#251), 21 drafts |
| GitHub open issues (#110, #124, #138, #152) | Full | CI billing lock (Jul), frontend type debt, GPT upgrades |
| Cloudflare account | Read via API | Workers, D1, KV, R2 inventory and live D1 state |
| Vercel team `admin-25521151s-projects` | Read via API | Production + preview deployments |
| Claude Code sessions (cloud, iOS) | Session list only | Titles, dates and repos for 40+ sessions |
| Local PC sessions (`gem-assist-*`, `GEM PC: *`, VS Code/PowerShell) | **Blocked** | Restricted to the owner's trusted devices; transcripts cannot be read from a cloud session |

Relevant sessions for this repo: *Complete FastAPI crypto trading backend* (2026-02-16),
*Crypto signal bot validation* (2026-10-23), and the local CLI sessions
`gem-assist-*` (2026-10-23/24). Open those in the Claude app on your PC to review or
continue them.

## 2. Live infrastructure (verified 2026-10-24 ~20:30 UTC)

| Component | State |
| --- | --- |
| Vercel `crypto-signal-bot` production | READY, serves `main` @ `70ec4e3` |
| Worker `crypto-signal-bot-api` | Deployed (last modified 2026-10-04); crons firing — last `cron_fired` audit event 20:20 UTC |
| D1 `crypto-signal-bot-db` | 19 tables; 2,732 market snapshots, latest 20:30 UTC, 0 stale; 13,937 audit rows; 5 user profiles; `orders.idempotency_key` present (migration 032 applied) |
| KV `crypto-signal-bot-api-agent-memory` | Exists; ID matches `wrangler.toml` (`2dcb1050…`) — the "KV/R2 blocker" from 2026-10-01 is resolved |
| R2 `crypto-signal-bot-storage` | Exists; matches `wrangler.toml` |
| Workers `crypto-signal-bot-live-candidate`, `crypto-signal-bot-reviewed-operations` + D1 `crypto-signal-bot-live-candidate-db` | Deployed 2026-10-04; candidate/quarantine lanes, not the production path |

Notes:
- `signals` has 0 rows by design: `/signal/latest` computes on request and only persists
  when explicitly asked (`worker/src/compat.ts` `latestSignal(..., persist)`).
- The production Worker was last deployed 2026-10-04, after the last Worker change on `main`
  (2026-09-29). Run `npm run verify:deployment` from a trusted machine to confirm the deployed
  bundle matches `main`; if it reports drift, run the manual `deploy.yml` workflow with
  `deploy_worker=true`.

## 3. Validation of `main` (run in this session)

| Gate | Result |
| --- | --- |
| `npm run lint` / `typecheck` / `typecheck:architecture` | Pass |
| `npm run test:run` | 51/51 pass |
| `npm run build` + performance budget | Pass (entry 256,605 bytes) |
| `worker: npm run build` | Pass |
| `worker: test:live-foundation`, `test:provider-contracts` | Pass, 0 failures |
| `worker: verify:paper-safety` | Pass |
| `worker: verify:migrations` | Pass (29 files, 020–030 replayed) |

## 4. What is done

- React/Vite/TypeScript frontend: dashboard, account, admin, infrastructure, status pages.
- Cloudflare Worker API with D1/R2/KV, paper-trading engine, Guardian, scheduled market ingestion.
- Usage-management plane (`/v1/management`): scoped roles, audit events, rate limiting.
- Paper-order idempotency (atomic reserve-first), fail-closed rate limiter and Guardian, stale-price guard.
- Read-only Bitget recovery: restart scan, GET-only reconciliation, attested recovery cycle.
- Safety locks: `/intent/live`, `/live/order`, `/withdraw` return 403; paper/testnet enforced.

## 5. What remains

| Priority | Item | Owner |
| --- | --- | --- |
| P1 | Confirm deployed Worker matches `main` (`npm run verify:deployment`) | You (trusted machine) |
| P1 | Review/merge Dependabot #252 (security bumps) | You |
| P2 | Triage 21 draft PRs (#232–#250): live-admission, provider-credential and recovery work from 2026-10-04/05. All target a future live release and are **not** needed for paper use | You |
| P2 | PR #251 Bitget V3 read-only client — ready for review | You |
| P3 | Close or update stale issues #138/#152 (CI billing, July) if Actions now run | You |
| P3 | Remove `__branch_probe_do_not_merge.txt` from `main` | Any |
| Blocked by policy | Live trading, mainnet, withdrawals — deliberately disabled; require a separate audited release | — |

## 6. Start using it now (paper mode)

1. Open <https://crypto-signal-bot-indol.vercel.app/dashboard>.
2. Confirm the header shows **Paper** / **Certification**, and in **Infrastructure** that mode is
   `paper`, network `testnet`, live trading and withdrawals disabled.
3. Sign in via **Account** (Supabase auth) for persistent portfolio and audit history.
4. Pick BTC/USDT, read signal, confidence and risk decision; rehearse an order only when the risk
   panel approves (sent to `/intent/paper`, never to an exchange).
5. Review portfolio, audit trail and P&L; use **Backtest** for historical comparison.
6. Health check at any time: <https://crypto-signal-bot-indol.vercel.app/status>.

Full procedure: `docs/OPERATOR_QUICKSTART.md`. Local development: `README.md` → *Local development*
and `docs/RUNBOOK_LOCAL.md`.

On Windows (PowerShell, from your VS Code checkout):

```powershell
git pull origin main
npm ci; Push-Location worker; npm ci; Pop-Location
npm run verify:deployment          # confirms live Vercel + Worker match the release contract
# Optional local run (two terminals):
Set-Location worker; npm run dev:local
npm run dev
```
