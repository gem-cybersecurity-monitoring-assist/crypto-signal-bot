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
