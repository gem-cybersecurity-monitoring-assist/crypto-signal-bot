# Bitget Classic v2 / UTA v3 account-family review — 2026-11-23

## Purpose
A Bitget Classic Spot v2 candidate must never be treated as compatible with
a Unified Trading Account (UTA) v3 execution account. This source-only review
artifact prevents accidental API-family mixing as an input to a future
independent live release review.

Official sources rechecked on 2026-11-23:
- Classic Spot place: https://www.bitget.com/legacy-docs/classic/spot/trade/Place-Order
- Classic Spot cancel: https://www.bitget.com/docs/catalog/classic-spot-trade/classic-spot-trade
- Classic-to-UTA upgrade: https://www.bitget.com/docs/classic/uta-api-upgrade-guide
- UTA v3 order management: https://www.bitget.com/docs/catalog/trading/order-management

Classic Spot POST `/api/v2/spot/trade/place-order` uses `size`. A market BUY
is **quote-sized**. The Classic `force` field is valid for limit orders and
invalid for market orders. The source-only candidate and demo-only transport
now omit `force` for market orders; limit orders retain an explicitly checked
`force`. Signed-body fixture hashes were regenerated using the documented
timestamp + POST + exact request path + exact JSON body HMAC-SHA256 contract.
The adapted tests never contact Bitget.

UTA uses a different v3 route, category (SPOT), quantity and time-in-force
semantics; there is deliberately no automatic translation of these Classic
v2 candidates into UTA order requests. UTA requires its own reviewed adapter.

## New source-only review gate
`worker/src/live/adapters/bitget/spot-family-review.ts` checks:
- scoped expected account matches the account-family observation;
- declared and observed account families agree and are not UNKNOWN;
- external family evidence is explicitly required, hash-shaped and recent;
- v2 mutation endpoint is an exact documented operation;
- candidate hashes, safety locks, identity and GET-only recovery plan pass
  the existing immutable demo candidate-integrity verifier.

All output always has `executionAllowed=false`,
`providerMutationAllowed=false`, `mainnetAllowed=false`,
`automaticRetryAllowed=false`, and `withdrawalAllowed=false`.
A `REVIEW_COMPATIBLE` result is **not** an exchange certification,
authorization, order instruction or release approval. The caller must independently
verify the origin/identity of any family evidence; a boolean or hash-shaped
operator input is not proof on its own.

## Current non-live boundary
No account credentials, authenticated provider requests, production Worker
bindings, or new order routes were added. Existing BTCC priority remains
unchanged. Real-money activation still requires an independently attested
account-family and exchange-permission check, the reviewed live signing and
one-shot submission/cancellation implementation, independent release approval,
small controlled activation limits, and reconciliation evidence.
Withdrawals remain separately prohibited without owner authorization.
