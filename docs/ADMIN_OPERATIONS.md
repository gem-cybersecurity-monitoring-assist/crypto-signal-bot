# Admin Operations

Authenticated administrators use `/admin` and its subordinate routes:

- `/admin/users`
- `/admin/access`
- `/admin/sessions`
- `/admin/usage`
- `/admin/audit`
- `/admin/system`

The frontend gate is convenience and user experience; the Worker remains authoritative.

## First release administrator

After the production identity provider is configured, authenticate the intended first administrator. The one-time bootstrap request to `/v1/management/bootstrap` must include:

1. an authenticated AAL2 bearer session; and
2. the Worker/server `BACKEND_API_KEY`.

The route writes an immutable audit event and grants GLOBAL `RELEASE_ADMIN`. Never put `BACKEND_API_KEY` in Vercel browser variables or local storage.

Run the bootstrap from a trusted machine with `node scripts/bootstrap-release-admin.mjs`. It signs in with password and authenticator code to reach AAL2, then prompts for `BACKEND_API_KEY` at a hidden prompt and sends it only to the Worker. Enroll an authenticator on `/account` first. `--check` prints the account's current roles without changing anything. If the key is unknown, set a new one with `npx wrangler secret put BACKEND_API_KEY`; Cloudflare secrets cannot be read back.

Migration 031 enforces a single `SYSTEM_BOOTSTRAP` claim at the database layer. Once claimed, bootstrap remains closed even if that administrator is later revoked; another authorized release administrator must manage recovery.

## User lifecycle

RELEASE_ADMIN can activate, suspend or disable another user. Suspension requires a reason and takes effect on the next protected authorization refresh.

## Access grants

Paper execution (`/intent/paper`) requires a current, non-revoked `TRADER` grant with scope `GLOBAL:global`; no other role implies it. Self-granting is blocked, so a solo owner uses two accounts: the bootstrapped administrator grants `TRADER` to a separate trading account in `/admin/access`.

RELEASE_ADMIN can grant/revoke the existing scoped role vocabulary after AAL2 step-up. The UI supports GLOBAL, EXCHANGE and ACCOUNT grants plus optional expiration. Only `GLOBAL:global` administrator grants authorize management-wide actions.

## Audit

Management mutations write immutable hash-referenced events. The management audit table has database triggers preventing update/delete.

## Incident posture

When identity, D1 or authorization evidence is unavailable, management access fails closed. Do not bypass management authorization to restore availability; repair the dependency.
