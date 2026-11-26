# Claude Code — Crypto Signal Bot final completion checklist

**Checkpoint: 2026-11-25.** This is the remaining-work index for Claude Code and
other engineers, not an approval or assertion that funded execution is ready.
Only Crypto Signal Bot is in scope. Do not integrate GEM Copy Center or other
GEM repositories. Reuse the existing Azure workspace and free-first services;
no new VM, Codespace, paid tier or unapproved costs.

## Resume from the consolidated upstream branch

- Repository: gem-cybersecurity-monitoring-assist/crypto-signal-bot.
- Integration branch: integration/claude-release-validation-20261125; draft PR #295.
- Earlier candidate PR #286 remains separate, head d253f653540fd88eefe3e4bf7cc3658221cdcca4.
- Main at this checkpoint: 72c295e25295bcbf5dd4daa73878b0eb7891bd8e.
- Claude fork commit already merged into the integration history: 169f1e4043d6b47e25c0f45aada6763c1a068419.
- Prior integration checkpoint: d331e997bbaa3b749f7d44dbe0d20e1b98ab4558;
  Worker CI run 45678805172 succeeded. Neither PR had recorded independent review.
- Fetch the current upstream branch and check its tree, CI, reviews, open issues,
  and concurrent changes before editing. Do not restart from the old Claude fork
  or overwrite a green release candidate. Preserve the original Azure worktree's
  local worker/src/index.ts modification. Use an isolated worktree.
- Read AGENTS.md, CLAUDE.md, docs/SAFE_FAST_PATH/*, docs/CLAUDE_INTEGRATION_VALIDATION.md,
  docs/PRODUCTION_COMPLETION_ACCEPTANCE.md, docs/FULL_LIVE_IMPLEMENTATION_ACCEPTANCE.md,
  docs/LIVE_EXECUTION_ARCHITECTURE.md, docs/WORKER_PYTHON_BOUNDARY.md,
  README_DEPLOY_HANDOFF.md. Older status documents are historical, not proof of
  the present deployment; inspect actual implementations when documentation conflicts.

## Implemented and verified

- [x] Combine original release and Claude frontend/Python refactor without
  replacing canonical Worker architecture or unrelated devcontainer setup.
- [x] Resolve CI policy mismatch; retain pinned Worker contract workflow and
  CircleCI aggregate gate. Keep stricter backend lint.
- [x] Fix exact frontend alias audit resolution and backend test isolation.
- [x] Reject invalid/stale price and candle observations; preserve provider
  response clock distinct from local receipt time and trade event time.
- [x] Prevent mixed candle histories during source changes and retain original
  source-attributed candle batches; reject unsupported/synthetic inputs.
- [x] Add prediction readiness API and bounded operator-authenticated read-only
  Python-to-Worker Guardian comparison. No state authority was transferred.
- [x] Preserve Guardian halt and drawdown on legacy executor startup; skip
  sweep if Guardian is unavailable, triggered, halted, heartbeat unhealthy,
  reconciling drift or cooling down. No new execution capability added.
- [x] Azure Python suite 662/662 after latest correction; backend lint,
  repository architecture audit, CI/release lock, static production contract,
  production target checks and operator frontend safety pass.
- [x] Previously recorded: 97 frontend tests, frontend production build,
  711 Worker foundation tests, 280 overlapping provider contract tests,
  61 Worker contracts; 90 focused candle/market-data/prediction tests.
  See validation doc for exact scope. Re-run on changed components.
- [x] Existing production frontend and Worker reachable at checkpoint;
  release attestation ok=true, failures=[]; Worker health ok, market data
  connected, paper/testnet, live and withdrawals disabled.
- [ ] Latest candidate remote CI and independent review after this handoff.
  A passed local test or old workflow is not current release acceptance.

## Remaining engineering — sequential acceptance gates

### P0: Consolidated deployment and architecture ownership
- [ ] Verify PR #295 vs #286 and main ancestry, every unresolved review,
  exact head CI including required CircleCI aggregate, and branch protections.
  Coordinate one release path with the existing hourly release automation;
  do not run overlapping production deployment or replace PR #286 silently.
- [ ] Inventory canonical Worker/D1/KV/R2, private service bindings, Vercel
  alias/manifest, identity project and actual Python origin. Record deployed
  revisions and rollback target; do not infer Python deployment from Worker health.
- [ ] Verify the latest exact integrated frontend build, typechecks, Python and
  Worker tests, paper safety, local migration replay, and deployment dry-run.
  Inspect the two existing warnings (Starlette deprecation and test mock
  serialization); do not conceal failures or weaken tests.
- [ ] Obtain genuine independent review and protected merge. After approved
  main CI, use existing guarded paper deployment workflow with account-scoped
  preflight, additive migration and rollback record. Keep known-good deployed
  production available. Update Vercel only when required and authorized.
  Verify exact release manifest, attestation, authenticated owner/admin access
  and deployment probes. Do not deploy unreviewed candidate or change live locks.

### P1: One operational system (paper-safe integration)
- [ ] Inspect SAFE_FAST_PATH phase status; keep Worker/portfolio Durable Object
  target ownership, with D1 projections. Do not create a second state writer.
- [ ] Finish authenticated, versioned signal synchronization with deterministic
  identity, sequence, source provenance, freshness, replay and divergence tests.
  Python candle/REST research is analytical, never executable price proof.
  End-to-end event-time, heartbeat and sequence continuity remain unverified.
- [ ] Establish single authoritative Guardian state. Current comparison only
  observes; test outage, split-brain, restart, stale status, explicit operator
  reset and halt persistence. Never clear risk state on service startup.
- [ ] Audit legacy Python executor: cached signal TTL, stale/REST prices,
  fallback equity/open-position defaults, direct percentage sizing and
  process-local last-acted state are unresolved architectural risks. Reconcile
  with existing risk authority and single-writer target; avoid parallel automatic
  order loops. Preserve supported paper behavior via reviewed migration and test
  that missing data cannot authorize a new entry or falsely report a fill.
- [ ] Reconcile portfolio, order identities, fills, reservations, cash, fees,
  PnL, audit cursors and protected reserve against one authoritative ledger;
  prove restart, duplicate, partial-fill and rollback behavior without copying
  incompatible independent ledgers. Unknown evidence must remain not_reported.
- [ ] Finish frontend wiring to canonical read models; verify authenticated
  operator roles, token/session expiry, account isolation and iPhone UX.
- [ ] Run deterministic simulation/replay, forward paper observation, fees,
  slippage, drawdown and out-of-sample evaluation. Report measured limitations;
  do not promise returns or label simulation evidence as actual provider fills.

### P2: Provider and release certification dependencies
- [ ] Verify current official BTCC supported API availability/contract; BTCC
  remains intended primary, Bitget secondary. Do not guess endpoints or bypass
  provider restrictions. Distinguish unsupported and unverified.
- [ ] Recheck owner-managed credential metadata (prior check found no named
  certification entries in the designated store; do not assume absent elsewhere).
  Keep secret values out of Git, chat, logs, browser variables and artifacts.
  Provider-issued credentials/permissions are owner-managed.
- [ ] Complete authorized isolated authenticated read-only Bitget certification
  after protected environment approval; confirm account model, scope, balances
  and historical observations with redacted evidence. Local fixtures are not
  external certification. Use provider-supported isolated demo only for
  separate acceptance rehearsal; no funded orders from this handoff.
- [ ] Record unresolved external provider and independent approval dependencies.
  Review final execution architecture, risk limits, recovery, monitoring,
  and exact release acceptance criteria with authorized personnel.
- [ ] Keep paper/testnet, mainnet, real-funds, provider mutation and withdrawals
  locks unchanged unless a separately reviewed and explicitly authorized
  release permits a specific change. No live activation, real-money orders,
  transfers or withdrawals are authorized by this checklist.

## Definition of final handoff

Update checkboxes only with commit SHA, actual test/run output and deployment
evidence. Report completed, blocked, not verified, and next prerequisite
separately. Continue independent unblocked engineering without duplicating
work. Do not self-approve a review, weaken branch rules, or mark funded
readiness from source tests. If approval/provider evidence is missing, keep
the existing healthy deployment available and document the precise blocker.

Production: https://crypto-signal-bot-indol.vercel.app
Worker: https://crypto-signal-bot-api.analyzer-d94.workers.dev

## Subsequent Claude session recovery checkpoint

- [x] Integrated latest Claude fork 1ab19c9 with the existing PR #295
  candidate in a separate worktree, preserving prior Guardian guards.
- [x] Added 29 extracted API contract tests and corrected API documentation.
- [x] Fixed application-wide TypeScript alias and auth validation typing.
- [x] Revalidated 707 backend, 167 selected legacy and 97 frontend tests,
  full application TypeScript, lint and static release gates.
- [ ] Complete broader coverage audit (including root tests outside
  backend/tests); inspect warnings, lifecycle tests and route ownership.
- [ ] Resolve legacy prediction-service versus candle-service read-model
  divergence; do not add a competing execution authority.
- [ ] Replace process-local optional idempotency with reviewed single-writer
  durable coordination; current sequential cache is not atomic and does
  not survive restart or replica boundaries.
- [ ] All remaining production release/provider/authority gates above remain.

## Agu continuation checkpoint

- [x] Run complete root test directory: 554 passed, 3 skipped.
- [x] Single-instance analytical signal lifecycle with awaited shutdown and
  regression tests; full backend now 709 passed.
- [x] Fix heartbeat test-double warnings and deprecated UTC conversion.
- [x] Previous consolidated GitHub Worker CI 45694264116 passed; final
  frontend build passed and production attestation remains healthy.
- [ ] Investigate intermittent SQLite thread callback during test teardown,
  other background task ownership, and legacy executor startup signature.
  Do not enable another automatic execution loop as a side effect.
- [ ] Resolve the three documented skipped external/integration checks
  with appropriate isolated evidence. The legacy prediction interface,
  cross-runtime state ownership, provider certification and protected
  release remain open; a local pass does not establish live readiness.

## Database lifecycle increment
- [x] Prevent session acquisition after database shutdown and after failed
  initialization; verify sequential restart and repeated startup.
- [x] Revalidate backend 712 passed; selected hardening 35 and persistence 21
  passed (overlapping suites); prior GitHub CI 45696777618 succeeded.
- [ ] Audit remaining background task ownership and concurrent lifecycle
  transitions; SQLite thread warning did not recur in the latest run but
  remains an intermittent finding until independently reproduced/resolved.

## Background ownership increment
- [x] Own and join the existing Guardian monitor, health monitor,
  reconciliation and surge scanner background loops.
- [x] Verify duplicate sequential starts and cancellation: 8 new tests;
  full backend 720 passed, selected service group 63 passed (overlap).
- [ ] Complete portfolio loop/persistence task ownership and concurrent
  lifecycle verification; legacy executor activation remains out of scope
  until authoritative state integration and reviewed release acceptance.

## Portfolio task ownership increment
- [x] Track existing portfolio snapshot/fill loops and queued persistence
  tasks; drain on shutdown with explicit timeout reporting.
- [x] Verify repeat startup, restore failure, write draining and timeout:
  724 backend and 49 focused tests passed (overlap).
- [ ] Verify concurrent lifecycle and durable transaction/restart accounting;
  task completion is not proof of database commit or atomic reconciliation.
- [ ] Continue authoritative signal/Guardian/ledger integration and external
  certification/review gates; do not enable competing automatic execution.

## Shared signal read-model checkpoint
- [x] Replace legacy Python signal endpoint stub read with common validated
  candle observation classifier, align readiness and status, and prevent
  incomplete research observations from being represented as Worker forecasts.
- [x] Verify 729 backend, 62 focused API/prediction (overlap), 98 frontend,
  full app typecheck, build, performance and static release checks.
- [ ] Finish authenticated cross-runtime signal sequence/identity, event-time
  evidence, unified Guardian and authoritative ledger reconciliation.
- [ ] Review remaining legacy prediction code and skipped end-to-end check
  against the new actual read contract; do not wire a second engine merely
  to satisfy obsolete assertions. Complete external provider and release gates.

## Reconciliation and Guardian evidence increment
- [x] Persist local P&L diagnostic reports using existing report table and
  distinguish historical, failed, expired, discrepant and unverified reports.
- [x] Correct Guardian observation source to actual launched monitor cycle;
  distinguish global observation from scoped/cooldown/drift/shared clearance.
- [x] Revalidate 740 backend tests, lint, architecture audit; prior
  Worker CI 45711248845 succeeded. Existing production attestation passed.
- [x] Recheck actual review and certification prerequisites: no recorded
  independent reviews on #286/#295; designated Bitget certification store
  has no named entries. Preserve production and record the external gates.
- [ ] Finish single-authority ledger/atomic transaction reconciliation and
  Python–Worker shared event identity/sequence; current diagnostic storage
  and Guardian observation are not authority migration. Distinguish missing
  historical DB report from inaccessible storage on restart.

## Cross-runtime signal history observation increment
- [x] Implement dedicated authenticated Worker historical-signal observation
  and operator-only Python comparison, preserving canonical request admission.
- [x] Verify 753 backend and 77 Worker contract tests, build and static
  release gates; previous Worker CI 45720083432 passed.
- [ ] Deploy through approved release, securely configure matching dedicated
  SIGNAL_OBSERVATION_READ_KEY bindings (never reuse a privileged operator
  key; no browser exposure), and verify authenticated end-to-end read.
- [ ] Establish authoritative shared market event identity and sequence,
  unified Guardian and atomic ledger reconciliation. The new historical
  observation contract deliberately does not assert any of these.

## Market-event and ledger integrity increment
- [x] Reject malformed identity, sequence and time evidence; retain last accepted
  market observation on rejected events, require explicit recovery for gaps.
- [x] Reject invalid accounting directions, fill sides and nonpositive
  reconstruction amounts using existing ledger modules.
- [x] Verify 83 Worker contract/fast-path, 714 foundation and 31 focused
  ledger/accounting tests (overlap), Worker build and safety checks.
- [ ] Establish running authenticated feed gateway and provider event provenance,
  sequence semantics and replay recovery. Existing registry remains ephemeral;
  do not report it as shared authoritative state.
- [ ] Continue shared Guardian and single-writer ledger integration, provider
  certification and protected release review. Journal validation is not proof
  of cross-runtime ledger reconciliation.

## Feed recovery increment
- [x] Reject invalid and mixed-symbol recovery evidence; latch buffer overflow
  and reject incomplete snapshot bridges.
- [x] Verify 94 Worker contract/fast-path tests, build and paper-safety.
- [ ] Integrate the recovery helper into a running, authenticated, symbol-bound
  gateway with source-proven snapshot identity and durable recovery evidence.
  Existing helper validation is not proof of synchronized runtime state.

## Shadow observation session increment
- [x] Connect depth recovery and feed-health registry in a symbol-bound,
  attempt-scoped local session; invalidate old observations during recovery.
- [x] Verify 99 Worker tests, including five new integration cases, build
  and paper-safety. Prior CI 45725350646 passed.
- [ ] Integrate the local session into a verified transport owner; authenticate
  provider snapshots, establish durable recovery evidence and verify end-to-end
  gateway behavior. No running production gateway is claimed.
