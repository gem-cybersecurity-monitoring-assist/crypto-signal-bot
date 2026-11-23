# Bitget Classic v2 + UTA v3 private read-only certification

## Scope

This integration combines the private source-only certification Worker from
draft PR #248 with the GET-only UTA v3 client from draft PR #251. It does **not**
merge their other unrelated branches or relax the existing production locks.
It contains no order-placement, cancellation, transfer or withdrawal transport.

### Official provider contract (rechecked November 23, 2026)

- UTA account info, including API-key permission type and permissions:
  https://www.bitget.com/docs/catalog/account/account-settings
  `GET /api/v3/account/info` includes `userId`, `permType`,
  and `permissions`.
- UTA account settings: same official catalog,
  `GET /api/v3/account/settings` includes `uid`,
  `accountMode`; the documented account modes include both `hybrid` and `unified`;
  switching/upgrading modes are not eligible.
- UTA Spot order history:
  https://www.bitget.com/docs/catalog/trading/order-management
  `GET /api/v3/trade/history-orders?category=SPOT&limit=10`.
- UTA migration and route differences:
  https://www.bitget.com/docs/classic/uta-api-upgrade-guide

This reviewer accepts provider read-only variants `readonly` and `read-only`,
  with `uta_trade` and
optionally `uta_mgt`, and **rejects** `read-and-write`, `withdraw`,
unknown permissions, a mismatched UID, and account settings outside
the documented `hybrid` or `unified` modes. This conservative contract may require further
review for legitimate but unrecognized provider account configurations.

### Private, authenticated service-binding endpoints

The pre-existing private Worker now supports:
- POST `/internal/bitget/inspect` — Classic v2 identity and permissions.
- POST `/internal/bitget/certify` — Classic v2 read-only contracts.
- POST `/internal/bitget/uta/inspect` — UTA v3 API-key scopes and account
  mode. Returns only hashed identity and scope evidence.
- POST `/internal/bitget/uta/certify` — UTA read-only contract checks for
  permissions, balances, positions, instruments, Spot order history and
  GET-only enforcement. Returns check statuses and evidence hashes, never
  balances, raw positions, orders, UID, IPs, secret values or request headers.

The same infrastructure-only bearer token is checked *before* any provider
secret is read, and the validated internal command requires
`runId`, `exchangeAccountId`, `expectedAccountRefHash`, and `productId`.
A caller must first perform the authenticated `inspect` step and bind the
expected UID hash before `certify`. A UID mismatch fails before balances
or history are requested. Inside the UTA certification harness, the
read-only key and account-family check must **finish successfully before**
any balance, position, instrument or order-history request is started.
If permission checks fail, those five subsequent checks are explicitly
`BLOCKED`, without contacting those provider endpoints. Local negative
fixtures validate that no downstream requests occur.

For an authorized `certify` request, the supplied `productId` is validated as
`BASE-QUOTE` and passed as a normalized symbol to both
`GET /api/v3/market/instruments` and `GET /api/v3/trade/history-orders`.
The instrument check requires one successful, exact matching **online Spot**
instrument; absent, suspended, cross-market or ambiguous responses fail.
The Spot order-history check rejects mismatched-symbol records but accepts
an empty result as a valid endpoint contract response. This is a bounded
read-only contract check, **not** complete reconciliation of historical orders
or proof of order execution. Official Bitget docs specify the optional
`symbol` request parameter for both endpoints and pagination on history.

Three provider values (`BITGET_CERT_API_KEY`,
`BITGET_CERT_API_SECRET`, `BITGET_CERT_API_PASSPHRASE`) are read **once per
invocation** from the declared existing Cloudflare Secrets Store bindings.
The service's `CERTIFICATION_RUNNER_TOKEN` is a separate deployment-time
infrastructure secret. Do not put secret values in URLs, PRs, chat,
workflows, frontend variables, or this document.

### Development and validation

```bash
cd worker
npm run test:live-foundation
npm run test:provider-contracts
npm run verify:paper-safety
npm run verify:live-candidate-safety
npm run build:live-candidate
npm run build:provider-contracts
./node_modules/.bin/wrangler deploy --dry-run \
  --config ../wrangler.provider-certification.toml \
  --outdir /tmp/crypto-signal-bot-v3-cert-dry-run
```

The repository keeps the provider-certification Worker private:
`workers_dev = false`, `preview_urls = false`, no public route, cron,
webhook, storage projection, or live order handler. Cloudflare dry-run
bundling **does not** prove that Secrets Store has active values, that a
compatible provider-issued key is configured, or that a remote signed
provider response was obtained.

### Release gating and remaining dependencies

- Local mocks and dry runs are **not external Bitget certification**.
- Verify Secrets Store binding metadata and read-only permissions in the
  canonical Cloudflare account, configure the infrastructure invocation
  token using the owner-controlled secret workflow, and deploy the private
  Worker only after an exact artifact/security review.
- Execute authorized `inspect` and `certify` through a trusted private
  service binding; retain redacted, hashed evidence in a reviewed location.
- Confirm which account/API family the actual owner account uses. Classic v2
  and UTA v3 must not auto-failover or share order credentials.
- The private UTA service also requires a fresh numeric Bitget `requestTime`
  on every HTTP 200/API-code-success response (signed private and public
  market instruments). The timestamp must be a safe integer in milliseconds,
  at most 120 seconds old and no more than 30 seconds ahead of the trusted
  server clock. Missing, stale, replayed, malformed or future-dated envelopes
  fail closed, without exposing raw provider responses. The option is enabled
  only by the private certification service; older local test fixtures remain
  backward-compatible unless they explicitly enable strict freshness.
  A successful v2/v3 read-only check does **not** authorize real-money
  execution. The independent live-order, cancellation, reconciliation,
  rollback and risk-control release has not been established here.

All capability locks remain `certifiedForLive=false`,
`executionAllowed=false`, `providerMutationAllowed=false`,
`withdrawalAllowed=false`, `transferAllowed=false`,
`automaticRetryAllowed=false`, and `credentialsPersisted=false`.
