# Event email delivery installation

## Applied scope

Owner-approved installation completed on 2026-11-26 against verified live
Supabase destination **`lvmzliemqnieeoruhkik`** (`iconn-multi-tenant`,
`eu-central-1`, healthy).

- Source: `supabase/migrations/202702010001_event_email_delivery.sql`
- Reviewed source SHA-256:
  `1bebb5412ea8bf34a6ba4bc437fa7de22c10159c9cb9ba3f0175450914aec563`
- Managed migration name: `event_email_delivery`
- Recorded managed migration version: **`20261126121412`**
- Tracking singleton `started_at`: **`2026-11-26T12:14:12.132632+00:00`**

Only the delivery ledger migration was installed. SOURCE was not used.
No application deployment, test email, resend, provider call, historical
backfill, worker, sync job, booking change or schedule change was performed.

## Preflight and installation mechanism

The managed Supabase integration independently confirmed the destination
project identity and healthy status. Read-only catalog inspection found no
delivery tables/indexes, relevant RPCs or event-email migration history, and
no resend-claim installation. The reported event was confirmed in `event`
(not `complex_event`), owned by BNMS.

Installation used the existing managed Supabase migration mechanism over its
authenticated HTTPS connection, explicitly pinned to the verified project ID.
The older private-event runner was not used because it disables certificate
verification. No direct database connection or TLS-verification bypass was used.

`scripts/event-email-delivery-install.mjs` builds only the hash-reviewed delivery
migration. One atomic DO statement strips the source's outer transaction
boundaries, acquires a transaction advisory lock, rechecks the event/tenant
identity, refuses any existing delivery object/function, and executes the
reviewed migration body. Installation checks and a PostgREST schema reload
notification are in that same statement.

If another executor installs anything first, the guard fails rather than
overwriting functions or resetting tracking evidence. Inspect actual state and
preserve the existing valid timestamp; do not bypass the guard or replay the
source merely because its filename version is missing from managed history.
The source migration remains byte-for-byte unchanged, including its original
prepared-only comment; the live installation status is recorded here.

## Verification

Local disposable PostgreSQL checks passed:

```sh
node scripts/run-isolated-tests.mjs --allow-local-postgres node --test scripts/event-email-delivery.postgres.test.mjs
node scripts/run-isolated-tests.mjs --allow-local-postgres node --test scripts/event-email-delivery-install.test.mjs
```

The existing suite passed both delivery-ledger and resend-claim tests locally;
the latter did **not** install the resend migration in production. The installer
test covers project/hash rejection, rollback rehearsal, partial-state refusal,
existing-timestamp preservation, source-equivalent functions and resend exclusion.

Live read-only verification after commit confirmed:

- All three tables exist with RLS enabled and no permissive policies.
- All six indexes (three primary-key indexes plus three lookup/recovery indexes)
  are ready and valid with their intended definitions.
- All ten primary-key, check and foreign-key constraints are validated.
- The singleton contains one finite tracking-start timestamp.
- `service_role` has SELECT on the three tables and INSERT on the ledger only.
  No UPDATE/DELETE or other unexpected table privileges were found.
- PUBLIC, anon and authenticated have no table access or RPC execution.
- All three RPCs are SECURITY DEFINER with
  `search_path=pg_catalog, public` and only owner/service-role EXECUTE grants.
- RPC body hashes match the reviewed source:

| RPC | Body MD5 (definition comparison only) |
| --- | --- |
| `record_event_email_send_result` | `a51a90f7a3a22933b60788068c079f47` |
| `apply_event_email_delivery_event` | `042a76f97afbb216ce8752cf25448c6b` |
| `event_email_delivery_stats` | `9c115e607b7f65c28cc6b047328d55e4` |

The read-only stats RPC executed successfully under `SET LOCAL ROLE service_role`
for tenant `ff2df806-b321-4254-b651-3af11fccf1db`, event
`1fb90343-a129-4fcf-affd-07db4d572a51`, returning `[]`.
The actual `loadEventEmailStats` application helper also succeeded against pinned
destination PostgREST using the existing service credential, returning:

```json
{
  "trackingStartedAt": "2026-11-26T12:14:12.132632+00:00",
  "emails": {}
}
```

Both ledger tables had zero rows after installation; no synthetic evidence was
created. Empty stats mean no tracked sends, not evidence that earlier emails
were never sent.

Read-only before/after row-content hashes matched:

| Scope for the reported event | Count | Unchanged MD5 |
| --- | ---: | --- |
| Event | 1 | `936c6cd7dfed3be95d9eb63d2664f671` |
| Email settings | 3 | `9a614ac1ffe105caa40b68e9984bad52` |
| Bookings | 63 | `4c5dc8aea4186cd59178679f57c47df5` |
| Scheduled emails | 125 | `18829559257d4d78dea94512e1dafc97` |

No authorized browser/application session was available. The deployed
authenticated `/api/event-emails/1fb90343-a129-4fcf-affd-07db4d572a51/stats`
endpoint and signed-in event editor were **not verified**. Database/PostgREST
success is not a claim of authenticated browser success. No auth bypass or
session impersonation was used.

## Separate pending prerequisite

`202702010002_event_email_resend_claim.sql` remains **not applied**.
The resend-claim table and claim function were confirmed absent after this
installation. Admin resend needs that separately approved installation; this
singular delivery-ledger request does not authorize it.
