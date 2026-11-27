# Authenticated durable order events

The existing `/ws/updates` socket continues to deliver public health/feed status.
Its private order channel uses the existing Worker Supabase identity verification,
management profile status and `READ_ACCOUNT` authorization policy. Browser access
tokens arrive in `authenticate_orders` frames; they never appear in URLs,
responses, dashboard events or stored cursors. User metadata cannot grant roles.

The dashboard authenticates this channel with its current Supabase session.
Changing identity clears cached events and the cursor; rotating a token preserves
the same user's replay cursor while replacing the socket. A disconnect marks the
private stream unavailable. Events are deduplicated by sequence, retained in a
bounded in-memory list and displayed in the dashboard's Order activity panel.

Before every batch, the Worker rechecks identity, ACTIVE profile status and
database roles. The existing authorization engine filters account scopes.
Revoked, expired, malformed and wrong-account grants cannot expose events.
Storage/authentication failure disables private delivery without fabricating
orders or weakening the public health channel. A generation fence prevents an
old pending identity/read result being delivered after reauthentication or close.
The complete read operation has an eight-second deadline.

The source is the existing `live_order_events` table joined to its canonical
order/account scope. Delivery includes immutable sequence/event/order/account
identifiers, previous/next states, source, observation time and payload/audit
hashes. Current mutable order prices or quantities are not attached to historical
state transitions. Reconnect replay begins after the last received sequence.
<!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:4d98c9ba04a1bbb8a9d4b5f52b0d99f26282cad9dafa707aa2f7504846debe96 -->

Each batch is capped at 100 events and the account read supports up to 50 accounts. After a full page, the Worker marks the status frame with `more: true`. The dashboard requests the next page at the last received cursor. A short or empty page ends catch-up; the twenty-second heartbeat continues checking for new events.

<!-- /coderabbit-ai-generated:v1 -->

Deployment requires the existing account/order/event schemas, user profile and
role schemas, the configured Supabase project, an ACTIVE user and a valid scoped
read grant. No exchange credentials or provider mutation permissions are exposed
to the browser. This change does not create events for a disconnected financial
writer or certify the still-incomplete live execution/accounting chain. Approved
state projection must produce evidence through the existing projection APIs.

Local evidence covers all existing lifecycle/block states, scope isolation,
cursor replay, revoked/malformed grants, expired identities, dependency failure,
in-flight reauthentication and disconnect. Production authenticated delivery and
the financial producer still require end-to-end verification. The separate
operator gateway foundation in PR #167 remains available for its more privileged
operator aggregation use case; this ordinary account-read channel reuses the
already deployed Worker identity authority.
