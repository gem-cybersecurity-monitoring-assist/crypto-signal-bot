# Bitget UTA v3 order-details recovery preflight (read-only)

## Scope

The source-only UTA Spot order candidates in
`worker/src/live/adapters/bitget/v3/unsigned-candidate-v3.ts`
now have a compatible read-only recovery endpoint in
`worker/src/live/adapters/bitget/v3/read-only-client-v3.ts`.
It is the signed **GET** endpoint
`/api/v3/trade/order-info?clientOid=<id>` or `?orderId=<id>`.
The implementation makes no mutation request and has no order signer,
live order submission, retry, or withdrawal integration.

Official Bitget API contracts checked on 2026-11-23:

- https://www.bitget.com/legacy-docs/uta/trade/Get-Order-Details
- https://www.bitget.com/legacy-docs/uta/trade/Place-Order
- https://www.bitget.com/legacy-docs/uta/trade/Cancel-Order

The UTA v3 read-only endpoint allowlist includes `order-info` as a private
GET route, without adding any write endpoints. Its request **requires exactly
one** vetted provider `orderId` or `clientOid`, and the client refuses extra
keys, unknown categories, path/query injection, dual IDs or invalid lengths
before signing or accessing credentials. The order-candidate `clientOid`
limit is reduced from 64 to Bitget's documented **32 characters**. The
conservative ID alphabet deliberately excludes some otherwise documented
punctuation characters pending independent review.

## Source-only review evidence

`worker/src/live/adapters/bitget/v3/order-info-review-v3.ts`
checks a purported provider response for:

1. API success code `00000`, numeric millisecond `requestTime`, at most
   120 seconds old and no more than 30 seconds ahead of the trusted clock.
2. A single exact `SPOT` product symbol and the exact requested order/client ID.
3. Known provider states: `live`, `new`, `partially_filled`, `filled`
   and `cancelled`, plus known order side/type.
4. Immutable SHA-256 hashes of provider identity and returned status/fill
   evidence; **no raw order IDs or client IDs are surfaced in the review**.

Even `filled` or `cancelled` is only a *provider observation*, not proof that
the financial ledger or position reserve has settled. Every review returns
`automaticRetryAllowed=false`, `providerMutationAllowed=false`,
`liveExecutionAllowed=false`, `ledgerSettlementConfirmed=false`, and
`independentReconciliationRequired=true`.

The existing private, infrastructure-token-protected certification Worker
now exposes `POST /internal/bitget/uta/order-info` as a **private service
binding**, not a public endpoint or provider mutation. Its input contains
the existing exact account-hash/product/run fields plus one validated
`orderIdentity`. It verifies the internal bearer token and command before
reading Secrets Store values, then verifies the read-only UTA API key and
UID account hash before making the signed provider **GET**. Its response
contains only immutable hashes, provider status and permanent safety locks;
no raw provider identities or balances are returned.

This is not proof of an authenticated production Bitget key, independent
account-family attestation, or a completed production settlement/retry
workflow. It does not enable live orders, public routes or financial writes.
Failed/unknown order-info lookups cannot justify automatically retrying the
initial order.

## Verification

```sh
cd worker
node --experimental-sqlite --experimental-strip-types --no-warnings --test \
  tests/live-bitget-v3-read-only-endpoints.test.ts \
  tests/live-bitget-v3-read-only-client.test.ts \
  tests/live-bitget-v3-order-info-review.test.ts
npm run test:live-foundation
npm run test:provider-contracts
npm run verify:live-candidate-safety
npm run build:provider-contracts
```

No external account certification was performed. Cloudflare Worker metadata
and Secrets Store access remain unavailable to the existing integration,
and Azure Wrangler is not authenticated to the canonical account. Production
trading is still disabled; withdrawals remain manual and owner-controlled.
