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
