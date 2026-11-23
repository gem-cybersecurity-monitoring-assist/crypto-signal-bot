# Bitget UTA v3 — source-only unsigned Spot order candidates

This isolated module documents the **future** UTA v3 request shape for a
separately reviewed live release. It cannot sign, submit, cancel, retry or
reconcile an order, access provider credentials, or create an execution
transport. It is deliberately **not imported** by production or candidate
Worker entrypoints. It does not change the existing Bitget Classic v2 builder,
existing paper mode, the user's BTCC provider preference, or withdrawals.

Official sources reviewed November 23, 2026:
- UTA order management: https://www.bitget.com/docs/catalog/trading/order-management
- Classic-to-UTA migration: https://www.bitget.com/docs/classic/uta-api-upgrade-guide

## Request model

- Place endpoint (evidence only): `POST /api/v3/trade/place-order`.
- Category always `SPOT`; no futures/margin/borrow or isolated trading modes.
- Market BUY `qty` is **quote** notional; limit BUY and all SELL `qty` are
  base units, preserving Bitget's documented unit semantics.
- Limit order requires reviewed `price` and `timeInForce`. Market order must
  omit both; no stop/trigger orders.
- `clientOid` is mandatory, typed and deterministic. Candidate validity is at
  most 120 seconds, with versioned product-rule validation and preview hash.
- `accountFamilyReviewHash` must have valid SHA-256 digest shape but **this is
  not proof that an actual UTA account was verified**. It is an evidence input
  requiring independent external attestation.
- Every candidate includes a GET-only `/api/v3/trade/order-info` recovery plan,
  an immutable canonical evidence hash, and explicit execution/retry/withdrawal
  locks. Ambiguous outcomes must never be automatically re-submitted.

- Cancel endpoint (evidence only): `POST /api/v3/trade/cancel-order`.
  Exactly one provider-issued numeric `orderId` or verified safe `clientOid`
  is required; `category` is `SPOT`. Cancel attempts are also completely
  disabled in this source-only module.

## Current controls and unfinished release prerequisites

All outputs permanently carry `POST_EVIDENCE_ONLY`,
`providerMutationAllowed=false`, `executionAllowed=false`,
`mainnetAllowed=false`, `withdrawalAllowed=false`,
`automaticRetryAllowed=false`, `transportSelected=false` and
`signingMaterialPresent=false`. There is no external API call here.

This is **not** an operational Bitget live order capability. Before any real
money execution, the owner-selected actual account family must be authenticated
through the isolated read-only private service; then an independent release
review must approve a separate narrowly scoped account-bound signing
transport, idempotency, portfolio risk and reserve authority, live order/cancel
ambiguity recovery, telemetry/kill-switch, smoke tests, and explicit first-order
authorization. No step in this branch grants that authorization.

To validate without credentials:

```bash
cd worker
node --experimental-sqlite --experimental-strip-types --no-warnings --test \
  tests/live-bitget-v3-unsigned-candidate.test.ts
node scripts/verify-bitget-v3-unsigned-candidate-safety.mjs
npm run test:provider-contracts
npm run verify:live-candidate-safety
```
