# Phase 3 — Isolated Shadow Feature, Scout, Fusion, and Risk Slice

## Status and scope

This is an **unbound, source-only** Phase 3 implementation on the
`feat/phase3-shadow-risk` branch. It is not a deployed execution engine.
No Worker entrypoint, public route, Durable Object, D1 writer, exchange
adapter, credential provider, queue, or mainnet configuration is connected
to these modules. Existing production paper/testnet behavior is unchanged.

The source is split into independently testable components:
- `features/shadow-feature-engine.ts`: per-feed O(1) EWMA midpoint
  momentum and realized volatility, top-of-book spread and optional
  best-level imbalance; bounded to 256 streams and 32 updates per event.
- `scouts/shadow-scouts.ts`: deterministic evidence observations;
  unavailable trade-flow, reversal and independently confirmed feed
  disagreement are **null**, not fabricated.
- `fusion/shadow-fusion.ts`: a bounded WATCH/CONSIDER_LONG classification;
  it cannot allocate capital or emit an executable order.
- `risk/shadow-risk.ts`: fail-closed simulated sizing, with freshness,
  source origin, heartbeat/sequence, Guardian, cooldown, drawdown,
  spread, volatility, liquidity, exposure, reusable cash and reserve
  separation. Every output has `executionAllowed: false`.

## Integrity boundary

The feature engine requires an **accepted** Phase 2 `FeedUpdateResult`,
healthy heartbeat/integrity/sequence, green freshness, a declared live
price origin, and a source age of at most 500 ms. It rejects stale or
cached prices, crossed books, mismatched feed identities and repeated
event IDs. Any rejected/unsafe event clears its stream history so a
recovered feed cannot inherit a previous momentum signal.

Only `book_ticker`, `level2` and `snapshot` records with a valid
top-of-book can contribute. Depth is not inferred from a price alone.
Top-level quantities are taken only from matching bounded updates;
depth remains null when unavailable. Signed trade flow, short reversal,
and independently verified feed disagreement remain `not reported`.

No calculated output is permission to send a demo order, real-money order,
withdrawal, provider mutation, retry, or production deployment. Source-only
shadow sizing is not an authoritative portfolio reservation.

## Validation commands

```bash
npx vitest run -c worker/vitest.config.ts worker/tests/fast-path/
npm --prefix worker run build:live-candidate
npm --prefix worker run build:provider-contracts
npm --prefix worker run test:live-foundation
```

The `shadow-phase3.test.ts` suite includes deterministic replay,
feed failures, memory bound, missing evidence, scout abstention, risk
locks, protected-reserve isolation, and local p95 timing. Timing is
calculated over 2,000 same-process iterations and **excludes** network,
Cloudflare platform, Durable Object, exchange, and order latency.
These measurements are a local target check, not a live latency claim.

## Remaining acceptance and rollout boundary

1. Complete independent review and merge of the existing Worker Node ESM
   import fix (PR #273); tests on unpatched main have that known failure.
2. Review this Phase 3 slice for input provenance and conservative risk
   defaults; then reconcile its rules with the versioned portfolio risk
   policy before adding any runtime bindings.
3. Implement an isolated replay harness with verified market feeds and
   independently authorized account state; prove safety and 15 ms p95
   under the actual chosen runtime.
4. Only after a separate review, integrate with Phase 4's single-writer
   portfolio Durable Object in **paper** mode. Live provider order
   transport and account credentials are not in this branch.

Rollback is to omit this source-only branch; no migrations, deployed
bindings, or persistent state are changed.

## Azure local evidence — 2026-11-23

- Fast-path Vitest: 6 files, 40 passed, including 19 new Phase 3 checks.
- Phase 3 2,000-sample local p95: **0.0116 ms**.
- Baseline fast-path 2,000-sample p95: **0.0127 ms** in the same run.
- Worker TypeScript candidate and provider-contract builds: passed.
- The full Worker suite on the original main revision had one pre-existing
  Node ESM import failure, addressed separately by PR #273. This work is
  based on that patch for its full-suite gate.
- No provider order, secret access, production deployment or account
  mutation was executed.

### Complete branch validation after stacking on PR #273

- Worker foundation: **467/467 passed**.
- Worker provider contracts: **180/180 passed**.
- Frontend: **55/55 passed**, production build and performance budget passed.
- Paper-safety, live-candidate safety, and local migration replay: passed.
- Worker candidate and provider typechecks: passed.
- This is a **source-only candidate**. Neither a provider order nor a
  Cloudflare production deployment was attempted.
