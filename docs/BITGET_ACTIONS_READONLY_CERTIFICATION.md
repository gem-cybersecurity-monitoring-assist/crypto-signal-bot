# Manual Bitget UTA v3 read-only certification through GitHub Actions

**Scope:** This is an alternative to blocked Cloudflare Secrets Store access for
the existing `gem-cybersecurity-monitoring-assist/crypto-signal-bot` source.
It reuses the project's existing private certification service in memory, on
an ephemeral GitHub Actions runner, using only Bitget's documented authenticated
**GET** endpoints. It cannot submit, cancel, repeat, move funds, withdraw, or
authorize a trade. It does not change production routes or Cloudflare Workers.

## Required owner-controlled setup

1. Review and merge the upstream UTA v3 certification PR chain through this
   workflow's own PR, including all tests and safety review. The workflow
   **refuses unprotected refs and non-main branches** before loading the Bitget secrets.
2. In GitHub repository settings, create a deployment environment named
   `bitget-readonly-certification`. Configure required reviewers and allow
   deployments from the protected `main` branch only. Environment creation
   alone **does not** establish reviewer protection; configure it explicitly.
3. Add these *environment secrets* (never paste their values in chat,
   source code, PRs or issue comments):
   `BITGET_CERT_API_KEY`, `BITGET_CERT_API_SECRET`, and
   `BITGET_CERT_API_PASSPHRASE`. Use a separate owner-controlled Bitget
   key issued for **read-only UTA Spot** data; never use a write/withdraw key.
   Verify that the key's region, permissions and provider IP rules permit the
   proposed GitHub-hosted runner.
4. From the repository's **Actions** tab, choose
   **Bitget UTA Read-Only Certification (manual, no trading)** and run
   `inspect`, with `acknowledge_read_only` enabled. Review its job summary. Treat it as public on a public repository. It reports a **hashed** provider user ID and UTA account family;
   it never emits raw credentials, UID or balances.
5. Run `certify` as a **separate owner-triggered workflow**, copying the exact
   account reference SHA-256 from the prior `inspect` job summary into
   `expected_account_ref_hash`. Use the same account alias and requested
   Spot product (default BTC-USDT). If account identity, read-only scopes,
   product, history, permissions, timestamps, provider network or any evidence
   contract fails, the job exits nonzero before reporting success.

Workflow:
`.github/workflows/bitget-uta-readonly-certification.yml`

Entry point:
`worker/scripts/run-bitget-actions-readonly.mjs`

## What is verified

- The GitHub job explicitly enforces its **manually dispatched**, protected
  `main` branch and owner read-only acknowledgement; it requests only
  `contents: read` and has a ten-minute execution ceiling.
- No Cloudflare token or long-running VM is needed. GitHub Actions usage can
  consume available private-repository CI minutes; check existing free quota.
- Existing Bitget private-service code checks environment-bound secret presence
  and uses an ephemeral random 256-bit infrastructure token in process memory.
- Every provider call passes a hardcoded HTTPS Bitget origin, **GET-only** method,
  no redirects, and the reviewed endpoint allowlist.
- `inspect` verifies account UID/mode and the strict read-only API key scope.
  `certify` requires an exact expected UID hash and the same read-only
  protections before account assets, Spot instruments and history are fetched.
- Responses are limited to a redacted, immutable verification summary and
  evidence hashes; the CLI logs only a fixed success/failure message. All
  financial execution, mainnet and withdrawal locks stay false.

This workflow does **not** create GitHub secrets, configure the environment
reviewers, certify the external account unless it actually runs successfully,
or automatically activate real-money trading. Even a fully passing read-only
certification is not approval for a live write transport or funded order.
Review/demo-order, portfolio limits, independent approval, release, kill switch
and monitoring remain separate gates. No withdrawals are automated.

## Local safe tests

```sh
cd worker
node --experimental-sqlite --experimental-strip-types --no-warnings --test \
  tests/live-bitget-actions-readonly.test.ts
node scripts/verify-bitget-actions-readonly-safety.mjs
npm run test:provider-contracts
npm run verify:live-candidate-safety
```

**Cloudflare permission issue is independent:** the connected Cloudflare
identity resolves to the expected account but currently lacks Workers
metadata and Secrets Store read access, and Azure Wrangler is unauthenticated.
The GitHub Actions workflow offers a genuinely separate, manual read-only
certification lane rather than claiming that access was fixed.
