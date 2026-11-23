# Operator Readiness — read-only Bitget API-family evidence

The operator frontend can display optional account-scoped `apiFamilyEvidence`
from the **trusted same-origin read-only operator gateway**. This does not
create an API-family verifier, external attestation, or live execution capability.

Expected optional gateway account envelope:

```json
{
  "apiFamilyEvidence": {
    "family": "CLASSIC_SPOT_V2",
    "reviewStatus": "REVIEW_COMPATIBLE",
    "sourceMode": "ISOLATED_READ_ONLY_CLIENT",
    "sourceVerified": true,
    "observedAt": "2026-11-23T12:00:00.000Z",
    "evidenceHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }
}
```

This envelope is an illustrative **schema example**, not evidence of any
Bitget account's status. The gateway must independently authenticate any
evidence it sends. `sourceVerified: true` and a SHA-shaped string by
themselves are not exchange certification or authoritative proof.

The browser accepts only recognized family/review values, a server assertion
of isolated read-only evidence origin, a 64-character lowercase evidence hash,
and an observation timestamp no later than the gateway timestamp and no more
than five minutes old. A `REVIEW_COMPATIBLE` status is allowed only for Classic
Spot v2, and only if the authenticated role has `CERTIFICATION` visibility.
Unknown/missing/stale/malformed evidence is shown as **Not reported**, not
inferred as verified or cleared.

The frontend's activation and capability locks remain permanently false in
this disabled-candidate view. The current `/api/operator/readiness` handler is
still a closed 503 placeholder until a trusted server-side identity gateway is
built and deployed. **No positive provider evidence is currently served by this
feature.**
