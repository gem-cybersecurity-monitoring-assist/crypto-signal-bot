# Durable paper order admission and high-water evidence — 2026-11-26

Scope: existing legacy Python paper portfolio; no new execution authority,
provider connection, database deployment, or funded activity.

- Pending limit orders become visible only after risk admission and a
  durable commit, serialized with fill and cancellation.
- An uncertain order persistence outcome latches recovery rather than
  reporting accepted state; the submit route returns HTTP 503.
- A fill must not overwrite a conflicting durable order status or identity.
- Marked equity updates a high-water mark durably before publishing it.
  Guardian uses that common computation, not an independent RAM-only peak.
- A failed peak commit blocks valuation and new paper activity until
  reconciliation. No historical evidence is rewritten.
- SQLite tests cover pending visibility during write, pending database
  failure, peak restart continuity and peak write failure.

Validation: 142 focused tests (one existing dependency warning);
793 full backend tests (two existing warnings); Ruff and git diff checks
passed on the Azure worktree. The frontend has not changed from the
previously tested 108-test candidate.

Scope limits: this is a single-process compatibility implementation;
production multi-runtime authority, restart reconciliation of ambiguous
outcomes, owner data scope, historical ledger migration, and exchange
certification are not established by these tests. Independent exact-head
review and protected merge remain necessary before deploying.
