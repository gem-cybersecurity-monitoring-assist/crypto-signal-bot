# Bitget demo composition — account-family preflight (2026-11-23)

The source-only demo certification composition now refuses to progress past
reviewed-authorization loading until an independently supplied, fresh
account-family record is compatible with the exact, hash-verified Classic
Spot v2 order candidate.

Before recording the immutable D1 control binding, the composition must:

1. Reload the reviewed demo authorization from D1 and use its **actual account
   scope**, never an account identifier provided by the candidate.
2. Ask the injected `accountFamilyEvidenceSource.loadVerified()` for evidence
   bound to that account, the candidate hash, and the evaluated timestamp.
   There is no built-in account API, global fetcher, secret store, or fallback.
3. Evaluate the record using `assessBitgetSpotFamily`: unknown, UTA v3,
   mismatched, stale, malformed, unavailable, and hash-tampered candidates
   fail closed. The fixture-based local tests are **not external attestation**.
4. Only after a source-only `REVIEW_COMPATIBLE` decision continue to the
   existing D1 binding, fresh-control reload, account serializer,
   one-shot evidence and demo-only certification runner.

The family check cannot activate trading or request a mainnet order. All
outputs retain the permanent execution, real-money, withdrawal and retry
locks. The composition has no Cloudflare binding, public/internal route,
default fetcher, or credential source. An independently authenticated
account-family source is still **unimplemented as a deployment adapter**.

The static verifier enforces the ordering:
reviewed authorization -> account-family preflight -> D1 control binding
-> adapters -> runner. Tests include verified-shaped mock evidence,
wrong/UTA/unknown family, account mismatch, staleness, missing and failed
loaders, and candidate tampering.

This is a source-only engineering prerequisite, not evidence of external
Bitget account certification, a deployed demo runtime, or live-mode approval.
