# Canonical Cloudflare deployment-account preflight

The manual paper Worker release previously checked only the configured
`CLOUDFLARE_ACCOUNT_ID`; the token could still belong to another account,
leading to Cloudflare error 10000 after the release gates.

The new `scripts/verify-cloudflare-token-scope.mjs` runs before either
manual Worker deployment entrypoint invokes a mutating Wrangler command.
It requires the canonical Analyzer account and validates that the
currently authenticated `CLOUDFLARE_API_TOKEN` can enumerate that account
using `wrangler whoami --json`. It rejects missing credentials, malformed
responses, unauthenticated results, and wrong-account scope. Any rejection
exits nonzero before `wrangler deploy`.

The preflight **does not** grant privileges, inspect exchange keys,
place orders, change Cloudflare resources, or correct the GitHub secret.
It deliberately suppresses raw Wrangler output (which may contain account
and user metadata) and outputs only generic success/failure messages.
It does **not** establish that the token has permission to edit the named
Worker. The actual Cloudflare deploy permissions still apply.

To test locally without account credentials:

```bash
node --test scripts/verify-cloudflare-token-scope.test.mjs
bash -n scripts/deploy-worker.sh
```

To deploy the paper Worker later, update the repository's existing
`CLOUDFLARE_API_TOKEN` GitHub Actions secret to a valid token for
the canonical Cloudflare account and retain `CLOUDFLARE_ACCOUNT_ID`
for the same account. Never paste a token into an issue, PR, or chat.
The manual deploy workflow still requires explicit selection and the
ordinary release checks. Nothing here enables mainnet, real money,
or withdrawal functions.
