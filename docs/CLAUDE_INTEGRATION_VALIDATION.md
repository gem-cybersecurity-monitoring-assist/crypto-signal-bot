# Claude integration candidate — Azure validation
Date: 2026-11-25. Local engineering evidence, not independent approval.
Parents: d253f653540fd88eefe3e4bf7cc3658221cdcca4 (PR 286);
169f1e4043d6b47e25c0f45aada6763c1a068419 (Claude fork).

- Integrated frontend/Python improvements; retained canonical Worker source unchanged.
- Excluded unrelated devcontainer terminal auto-start changes.
- Kept general GitHub advisory CI manual and retained blocking lint.
- Pinned the existing automatic Worker contract workflow exception in the CI policy verifier; negative controls reject changed workflow and new automatic workflow.
- Corrected exact TypeScript alias resolution in repo audit, with missing-target regression test.
- Ran hosted readiness test in a subprocess to prevent route mutation leaking into canonical API tests.
- Isolated audit store per Python test; full suite passed after reproducing audit response serialization stall involving shared mock state.
- Observed results: frontend build and performance gate passed; frontend 97/97, Worker contract 61/61, provider 280/280, Worker foundation 711/711 (overlapping provider suite), Python backend 613/613, stabilization selection 21/21 (overlapping backend suite).
- Worker/provider typechecks, paper safety, CI independence, release lock, migration replay, backend lint and repository audit passed.
- Python test warnings: Starlette TestClient/httpx deprecation; mock value serialization warning in execution-scope test. Frontend tests emitted React act warnings.
- No authenticated exchange certification, deployed validation, independent review, or funded execution claimed. Prediction-coordinator integration and cross-runtime reconciliation remain open. Production unchanged. Do not replace PR 286's head or merge without review.

## Prediction readiness increment
The deployed Python architecture already starts the candle-based signal service;
the legacy prediction module is not a second production signal authority.
The existing service now rejects unavailable, stale, non-finite, mismatched,
duplicated, non-contiguous or insufficient observed market inputs.
GET /api/v1/signals/prediction/{symbol} projects the same cached signal record
used by the Python service. Missing, expired and unverified observations are
explicit states. It neither initiates evaluation nor authorizes execution.
The response explicitly reports Worker synchronization and provider mutation as
false. Retrieval time is not exchange event-time proof, and the candle chain
does not yet carry end-to-end source provenance. Those are separate required
integration gates. No new execution route or secondary loop was enabled.
Azure: 10 focused tests, 623 total backend tests passed; backend lint passed.

## Market-data identity and provider clock increment
Bitget Classic spot public ticker documentation defines ts as current Unix
milliseconds, not a verified trade event timestamp. Retain the raw validated
provider clock separately from local receipt time through ticker, snapshot,
Redis cache and prediction readiness. Other providers report no provider clock
unless explicitly supported. The read-only endpoint reports current, outside
window or not reported, and permanently denies trade-event verification and
execution authorization. Reject mismatched ticker symbols before caching and
exclude unexpected/duplicate batch symbols. Legacy price route now returns
stale cache observations with original timestamp, explicit stale and no-store
headers. Updated outdated stale-exception expectation to match the existing
bounded snapshot contract; no weakening of stale classification.
Source: https://www.bitget.com/legacy-docs/classic/spot/market/Get-Tickers
Azure validation: 632 backend tests passed before legacy route correction;
42 focused market-data and prediction tests passed after correction, including
23 legacy market-data tests. No authenticated exchange calls or orders.
End-to-end trade event sequence and candle provenance remain open.

## Candle provenance increment
Ingestion retains the exact most recent nonempty adapter-attributed batch
separately from the deduplicated historical ring buffer. Provider changes
reset the ring; failed fetches invalidate the observation. The strict
prediction path uses one attributed batch only, refuses unknown sources,
synthetic CoinGecko candles and the uncertified BTCC candle source, and
checks batch symbol, interval, receipt age, sequence and OHLCV values.
Duplicate timestamps cannot be hidden by ring-buffer deduplication.
Legacy candle consumers retain their existing list interface. Coinbase
adapter source naming corrected. Prediction readiness expires the candle
observation and explicitly leaves trade-event time and execution unverified.
This is local adapter attribution, not authenticated provider provenance.
No cross-runtime authority or funded execution was introduced.
Azure validation: 639 backend tests, 90 selected ingestion/market-data/
prediction tests (overlap), backend lint and repository audit passed.

## Cross-runtime observation increment
Added operator-authenticated GET /api/v1/monitor/runtime-comparison. It
reads a fixed canonical Worker infrastructure endpoint through a bounded
HTTPS GET without credentials, redirects, or environment proxy configuration.
Only typed, fresh v2 observations with healthy D1 and an available Guardian
are compared. Local halt evidence is preserved; a local clear state requires
a running Guardian loop and recent heartbeat. Missing or malformed evidence
does not establish clearance. Matching observations do not unify authority.
Signal synchronization and portfolio reconciliation remain not_reported.
No financial state writes, automated dispatch, or authority changes added.
Azure: 654 backend tests, including 15 new comparison and transport tests,
lint and repository audit passed. A direct read-only production probe returned
Worker observed, halted=false, legacy_d1, paper_locked=true; standalone local
Python Guardian observation was unverified (no running loop in probe process).
This is not production acceptance of the Python runtime or an execution gate.

## Guardian startup and handoff increment
Removed legacy executor automatic Guardian reset/drawdown re-anchor and
made its sweep stop when Guardian state is halted, triggered, heartbeat
unhealthy, drift active, in cooldown, or unavailable. Status separates
startup observation from actual NAV anchoring. This does not establish a
unified Guardian or complete risk/portfolio authority. Full backend suite
662/662 passed, including 8 new focused tests; lint and static release
checks passed. Production GET attestation and Worker health passed;
existing paper/testnet deployment retained. Remaining tasks are tracked
in CLAUDE_FINAL_COMPLETION_TODO.md and linked from root CLAUDE.md.

## Resume after Claude Code usage limit (2026-11-25)
Fetched Claude fork head 1ab19c9c7a369df7917f4732a654b00bcdd4fa55
and merged against upstream integration head 74e5f4fc143346463ff59f656f76f514a2844ea0
in an isolated Azure worktree. The latest fork adds extracted configuration,
exchange, trading and reconciliation routes, prediction API compatibility,
legacy process-local idempotency and scoped Guardian/reconciliation tests.
Resolved three conflicts preserving original stale timestamps, no-store
headers and subprocess readiness-test isolation. Updated legacy executor
fixtures to explicitly represent healthy Guardian evidence, not bypass guards.
Added 29 API-surface tests (26 route/method checks, schema uniqueness and
prefix check, missing reconciliation, blocked live/withdrawal dispatch).
Corrected API docs to reflect actual flat signal response, blocked withdrawals,
operator comparison auth and legacy idempotency limitations.
Fixed application tsconfig backend alias and explicit Zod failure narrowing.
Evidence: 707 backend tests, 167 selected legacy/Guardian regression tests
(overlap), 97 frontend tests, full app typecheck, backend lint, repository
audit, CI independence, production targets and static release checks passed.
Initial merged frontend production build and performance budget passed;
final frontend build status is separately recorded in release evidence.
Worker sources unchanged. No deployment or financial operation performed.
Legacy prediction route remains separate from running candle service;
legacy optional idempotency is not atomic/durable; do not certify either
as authoritative execution integration. Independent review and external
provider certification remain open.

## Agu workflow — regression coverage and analytical lifecycle checkpoint

Previous published head 91692ba49b7891d4160acdc7412a2d9c51843d34 passed Worker
CI 45694264116 and the final frontend build/typecheck. Rechecked both
release PRs: no independent review recorded. Claude fork unchanged at 1ab19c9.
Completed the previously unrun root Python test tree (557 collected).
Added tracked single-instance analytical signal task lifecycle: repeated
startup is idempotent, shutdown awaits cancellation, clears observation
cache and joins ticker/heartbeat tasks before database shutdown. No new
execution authority or automatic order loop enabled. Updated three
synchronous heartbeat test doubles and UTC timestamp conversion.

Exact local results after changes: 709 backend tests passed; root suite
554 passed, 3 skipped; focused lifecycle/coordinator/price tests 39 passed
(overlap); backend lint and repository architecture audit passed.
Three root skips: authenticated exchange access, legacy prediction-engine
interface, running WebSocket/Redis end-to-end. Remaining warnings: Starlette
TestClient deprecation, mocked Pydantic serialization, intermittent aiosqlite
thread callback on closed loop, Decimal tolerance. Other service lifecycle
ownership remains to be audited. Python executor startup signature mismatch
is an unresolved integration finding; do not silently activate a parallel
executor. Legacy prediction service remains separate. Current production
attestation returned ok=true, failures=[], paper/testnet locks intact.
No deployment or provider mutation performed.

## Database lifecycle checkpoint (2026-11-25)
Fixed a closed-engine session-factory leak: shutdown now removes the published
factory and engine before disposal, preventing new sessions from reopening
the closed engine. Sequential repeated initialization reuses the active
engine. Failed schema initialization disposes the unpublished engine and
does not expose a usable session factory. Temporary SQLite and mocked engine
tests cover restart, disposal, and failed initialization.
Azure: 712 backend tests passed, 35 focused hardening/lifecycle tests and
21 persistence/lifecycle tests passed (overlap); lint and architecture audit
passed. The previous intermittent SQLite thread warning did not recur in
the full backend run; this is not proof of resolution of all background
task shutdown defects. Other existing warnings remain. Concurrent database
startup/teardown and remaining service ownership need further review.
Previous published head 65e47c09 passed Worker CI run 45696777618.
No production deployment, authority change or financial operation performed.

## Background service ownership increment (2026-11-25)
Existing Guardian monitor, health monitor, reconciliation and surge scanner
loops now retain task handles, reject duplicate sequential starts, and await
cancellation at shutdown. App lifespan directly awaits scanner startup and
stops these services before portfolio persistence/database shutdown.
No change to signal strategy, order routing, or financial authority.
Eight new lifecycle tests cover duplicate starts, cancellation, restart and
stop-before-first-tick. Azure full backend 720 passed; 63 focused service
tests passed (overlap); lint and repository audit passed. Existing two
test warnings remain, SQLite thread warning not observed in this run.
Prior published checkpoint d48d8e11 passed Worker CI 45709367226.
Remaining: portfolio snapshot/fill-task and persistence lifecycle, concurrent
startup/shutdown race analysis, legacy executor signature mismatch (do not
silently activate), and cross-runtime state/authority/release gates.

## Portfolio task ownership increment (2026-11-25)
Existing paper portfolio snapshot and limit-fill loops now retain handles,
prevent duplicate sequential startup and wake on a stop event. Shutdown
drains current loop work, tracks pre-existing asynchronous position/order
writes, and waits for them before database disposal. A bounded wait reports
incomplete persistence on timeout and cancels overdue tasks. App lifespan
calls the portfolio shutdown routine before database close. This is task
ownership and graceful shutdown, not atomic ledger reconciliation or
proof that best-effort writes committed. No change to execution authorization,
order sizing, fills, provider mutations or trading mode.
Azure: 724 backend tests, 49 focused portfolio/console tests (overlap),
including four new lifecycle tests; lint and architecture audit passed.
Two pre-existing test warnings remain. Previous candidate 38e6ec57 passed
Worker CI 45710182891. Concurrent lifecycle races, cancelled or interrupted
transactions, durable accounting and restart reconciliation remain open.

## Shared Python signal read-model increment
The legacy GET /signal/latest and versioned prediction-readiness endpoint
now read one analytical candle cache through a common observation classifier.
The legacy route no longer invokes the disconnected prediction stub or
recomputes on GET. Both agree on signal identity, freshness and unavailable
states; malformed confidence/symbol evidence is unverified. No forecast
regime or forecast horizon is inferred from cache TTL. The canonical Worker
forecast display and AI insights exclude Python-only research observations
until a compatible, synchronized contract is verified.
Azure: 729 backend tests, 62 focused prediction/API tests (overlap), 98
frontend tests, full application typecheck, production build, performance
budget, operator frontend safety, CI policy, lint and architecture audit
passed. Existing test warnings remain. The legacy prediction module's
direct unit tests are retained; it is not the current API read authority.
This unifies Python reads only, not Python/Worker state authority, forecast
classification, or authenticated exchange data. No trading dispatch,
provider mutation, production deployment, or financial lock changes.

## Durable diagnostic reports and Guardian observation (2026-11-25/26)
Reconciliation previously claimed DB persistence but only cached four fields.
It now saves successful local P&L diagnostic reports to the existing table,
exposes committed/unavailable persistence status, and recovers the latest
mode-scoped committed report as historical after loss of the process cache.
Failed/non-finite observations supersede stale success with unavailable
state and no fabricated balance in the read model. Expired, historical and
discrepant reports are distinct; local ledger and Worker reconciliation
remain explicitly false. The existing drift heuristic is not transaction
reconciliation, and DB read failure versus absence needs further refinement.
The Guardian comparison now uses the actual running monitor's successful
cycle timestamp (not generic application heartbeat or the unlaunched
separate service loop). Scoped blocks, cooldown and drift are distinguished
from global halt; Redis/shared clearance remain unverified. Non-paper or
missing runtime lock evidence cannot establish a comparable Worker state.
Azure 740 backend tests passed, including 11 new tests; 47 initial
reconciliation/API and 43 Guardian/lifecycle/reconciliation focused tests
passed (overlap); lint and architecture audit passed. Two existing
warnings remain. Prior head 1d0a14b3 Worker CI 45711248845 passed.
Fresh read-only release checks: production attestation ok=true, failures=[];
Cloudflare deployment 4680c449-ff3b-4965-a132-84918828a756, active version
b6abf531-dfba-4b40-aa71-7a5e09a2c0c2 at 100%; no independent reviews on
PRs #286/#295. Designated certification Secrets Store list returned zero
entries; the three named Bitget certification entries were not present.
This does not establish absence in all secret stores. No secret values
read, no authenticated provider certification, no production mutation.

## Authenticated cross-runtime signal history observation
Added dedicated Worker GET /v2/signals/observation?symbol=BTC with a fixed,
bound SELECT of one persisted signal row, after canonical rate admission
and before the legacy schema initialization path. It never calls price or
order routes. Admission retains its existing counter write. The new
SIGNAL_OBSERVATION_READ_KEY binding is exclusively for this read route;
no general backend/operator key is forwarded by Python. Missing or wrong
dedicated credentials fail closed. Row identity, symbol, UTC timestamp,
timeframe, side and confidence are validated. Persisted rows are historical,
not provider events, and do not establish executable freshness or sequence.
Python operator-only GET /api/v1/monitor/signal-comparison/{symbol} reads
local validated observations and the fixed HTTPS Worker endpoint using
bounded response size/time, no redirects or proxy environment. Independent
namespaces are explicit; shared event, sequence, synchronization and
execution authorization are not claimed. No competing state writer.
Azure full backend 753 passed, 13 new Python tests; Worker contracts 77
passed (16 additional cases), Worker build, paper-safety, CI independence,
production target checks, backend lint and architecture audit passed.
Prior CI 45720083432 succeeded. Production attestation remains healthy.
The new key is not configured in production by this increment; deployment,
secure provisioning of a dedicated least-privilege key on both server
runtimes, and authenticated end-to-end verification remain required.
No secret values read or written, no production deployment.

## Market-event integrity and ledger validation increment
Hardened the existing shadow Worker event normalizers and feed registry.
Missing provider timestamps no longer default to local receipt time; malformed
or fractional sequences, noncanonical event IDs and future-dated observations
are rejected. Rejected market updates do not advance accepted market timestamps.
A known gap or malformed stream remains unavailable/resyncing until explicit
recovery; recovery invalidates old observation timestamps. Heartbeats do not
replace market-data freshness. This is shadow evidence validation, not a running
production feed gateway or cross-runtime event synchronization.
Hardened existing ledger journal and reconciliation validation so unknown
debit/credit directions, unknown fill sides and nonpositive reconstruction
amounts cannot be treated as valid accounting evidence. No changes to trade
authorization, provider calls or ledger ownership.
Azure: 83 Worker contract/fast-path tests, 31 focused ledger/accounting tests
(overlap), 714 full Worker foundation tests passed; Worker TypeScript build,
paper, regulated foundation and certification safety checks passed. Nine new
test cases. Prior checkpoint 11c7693e CI 45720961334 passed. Production
attestation ok=true, no failures. The Python source is unchanged from the
previous 753-test checkpoint. Remaining: actual feed gateway, authenticated
event provenance and sequence semantics, recovery lifecycle, shared Guardian,
single-authority portfolio reconciliation, certification and reviewed deployment.

## Market-feed recovery integrity increment
The existing Binance depth recovery helper now rejects malformed and
future-dated events, mixed symbols, non-depth sources and invalid snapshot
sequences. Buffer overflow latches unavailable rather than silently discarding
history; reset/begin is required for a new recovery attempt. A partial bridge
cannot be returned as an applicable batch, and buffered input is copied to
prevent later caller mutation. Snapshot identity and authenticity remain
caller dependencies; the helper is not a deployed feed gateway.
Azure: 94 Worker contract/fast-path tests passed (11 new recovery cases),
Worker TypeScript build and paper-safety checks passed. Prior checkpoint
5a7c4032 passed Worker CI 45722916914. No authority, provider or deployment
changes. Existing shared-feed, Guardian and ledger integration requirements
remain open.

## Symbol-bound shadow depth observation session
Added DepthObservationSession to connect the existing Binance depth recovery
helper and feed-health registry. Recovery invalidates prior observation
timestamps; attempt IDs reject delayed snapshot responses, and symbol,
source, receipt window and sequence are checked. A complete bridge updates
sequence evidence only; a subsequent accepted stream event is required
before reporting a market timestamp. Gaps start a new recovery, and invalid
events, incomplete bridges and timeouts fail closed. Registry refuses
recovery completion outside resyncing state. Five integration tests exercise
normalization, recovery, gap handling, attempt isolation and timeout.
Azure: 99 Worker contract/fast-path tests passed, Worker TypeScript build
and paper-safety passed. Previous checkpoint 5d9e21e2 CI 45725350646 passed.
The session is a local in-memory component, not a deployed transport. It
does not authenticate provider snapshots, persist recovery evidence, or
authorize any execution. The actual gateway, transport/session ownership,
provider verification, shared authority, reviewed deployment and
certification remain open.

## Depth transport callback boundary
Added a bounded provider-shaped JSON frame adapter for the local depth
observation session. Validates symbol, sequence, timestamp and decimal
level fields, rejects malformed/oversized frames and clock regressions,
and isolates callbacks from prior connection generations. Disconnect
marks the observation session unavailable. Snapshot responses remain
bound to the caller's requested symbol and recovery attempt; provider
authenticity is not established. No sockets are opened by this component.
Azure: 110 Worker contract/fast-path tests passed, including 11 new
transport cases; Worker build and paper-safety passed. Prior checkpoint
03661d3a CI 45761902412 passed. Actual socket lifecycle ownership,
authenticated provider retrieval, durable recovery evidence and shared
authority remain outstanding.

## Bounded testnet transport probe (2026-11-26)
Added an opt-in, one-shot observation probe using the existing depth transport,
the documented Binance Spot testnet WebSocket and public REST depth snapshot.
Reference: https://developers.binance.com/en/docs/products/spot/testnet/web-socket-streams
One socket, at most one credential-free GET, bounded response size and deadline,
no redirects on REST, no reconnect/retry, no account or order API. It waits for
buffered sequence evidence, a snapshot bridge and one subsequent stream event,
then closes. This is an observation-only diagnostic, not a deployed gateway.

Validation: 115 Worker contract/fast-path tests passed (five new probe cases),
Worker build and paper-safety passed; Node 22 probe bundle succeeded. Previous
checkpoint ae9bcb4e CI 45762216690 passed. On Azure, the actual one-shot probe
at 2026-11-26T06:11:03.078Z opened the testnet socket but reported
snapshot_unavailable, snapshotReceived=false, bridgeVerified=false,
subsequentObservation=false, lastSequence=null, exit=1. The precise snapshot
failure reason was not captured; no retry was made. This confirms socket
access, not an authenticated account or a verified snapshot bridge.
Production release attestation returned ok=true, failures=[], paper/testnet,
mainnet/live/withdrawals/provider mutations/real funds disabled.
No production deployment, financial operation or provisioning performed.

Run from repository root with existing dependencies:
  worker/node_modules/.bin/esbuild worker/scripts/run-depth-testnet-probe.ts --bundle --platform=node --format=esm --target=node22 --outfile=/tmp/csb-depth-testnet-probe.mjs
  timeout -k 2s 12s node /tmp/csb-depth-testnet-probe.mjs
Only run when permitted by provider/network access; do not circumvent denial.
