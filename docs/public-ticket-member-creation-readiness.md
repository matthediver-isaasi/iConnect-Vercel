# Public ticket contact creation: release readiness

## Scope and authority

Public-only standard and complex tickets can opt into creating contact records
for the explicit purchaser and the attendees receiving enabled tickets. The
provisioning role is separate from purchase-eligibility roles. Administrators
must select a same-tenant, non-administrative role without effective-date or
capacity requirements. Organisation names are descriptive member data, not
verified affiliations.

Server preparation validates required identities, conflicting identities/roles
and exact tenant-local email eligibility before payment. Immutable receipts
bind the canonical identities and ticket policies to a purchase UUID. Stripe
preparation uses that UUID for idempotency. Enabled bookings use an atomic
complete-batch database function, including capacity checks and seat changes.
Member creation runs only after captured, unrefunded payment or confirmed free
booking; unpaid Invoice/PO, authorizations and incomplete batches are excluded.

New contacts have login and directory visibility explicitly disabled. No
membership, invitation, marketing consent or organisation access is created.
Original guest booking ownership remains unchanged. Receipt links separately
identify purchaser/attendee contacts and attendee booking IDs.

Creation is all-or-nothing per receipt. An unrelated duplicate or changed role
policy becomes a durable conflict rather than an adopted/modified member.
Replay recognizes the original purchase. Recovery rechecks the booking batch
and, where applicable, the provider. The administrator diagnostics in both event
editors expose outcomes and explicit retries. The protected reconciliation cron
processes bounded batches without charging or creating bookings.

Atomic capacity rejection records a durable refund-pending outcome even when
no booking rows exist. The handler attempts a provider-verified, idempotent
refund; interruptions remain discoverable by the recovery sweep and the
administrator's Retry refund action. Refunded or unavailable free purchases
are excluded from contact creation. Transient database errors remain distinct
from terminal capacity loss.

## Migrations and verified target

Read-only inspection verified destination Supabase project
`lvmzliemqnieeoruhkik`, with matching REST project and SQL connection identity.
It had the valid normalized unique index `member_email_tenant_unique_ci_idx`,
a separate case-sensitive tenant/email unique index, and no duplicate groups
under the existing normalized-email definition. No production data was changed.

Apply these migrations **in order, only after explicit approval**, to the
verified destination database:

1. `supabase/migrations/20261005120000_public_ticket_member_policy.sql`
   adds policy/descriptive-organisation fields, exact service-only lookup, and
   an additional normalized unique index covering JavaScript-trim whitespace.
   Existing indexes remain. Historical collisions abort installation; do not
   merge or delete those records automatically.
2. `supabase/migrations/20261005121000_public_ticket_member_evidence.sql`
   creates private immutable purchase receipts, creation/link evidence and the
   atomic member-creation function with role, batch and duplicate guards.
3. `supabase/migrations/20261005122000_public_ticket_member_booking_batch.sql`
   installs atomic booking-batch/idempotency authority and schema readiness.

After explicit database-only approval, all three migrations were applied in
the order above to destination Supabase project `lvmzliemqnieeoruhkik`.
REST origin and SQL connection project pins were rechecked with verified TLS.
The preflight found **zero historical collision groups** under the strengthened
JavaScript-trim normalization. No historical contacts were merged or deleted.
SOURCE and the workspace runtime configuration were not changed.

Applied SQL SHA-256 evidence:

| Migration | SHA-256 |
| --- | --- |
| `20261005120000_public_ticket_member_policy.sql` | `5aeb49ccb7f5e300542783d0f0e5c9677b9f97f4b09507e68adc17f45b6ee5cd` |
| `20261005121000_public_ticket_member_evidence.sql` | `d1abb342f03dc1456aacb6f44859b00a23e96531eeb6fb36bbba91cf510ede9c` |
| `20261005122000_public_ticket_member_booking_batch.sql` | `f24b8213b9d833299d0f31fc1608f3ebe06ed91e1dca7f26d0b43329668d4443` |

Post-apply destination SQL checks passed:

- Both historical email uniqueness indexes remain valid and ready; the new
  normalized unique index is also valid and ready.
- Lookup, preparation, provisioning, booking-batch and readiness functions
  permit `service_role` execution, not PUBLIC, anon or authenticated execution.
- Both evidence tables have RLS enabled and no PUBLIC, anon or authenticated
  table privileges.
- `public_ticket_member_creation_ready()` returned true while executing as
  `service_role`.

No migration in this list remains pending. Deployment and synthetic purchase
approval remain separate: neither deployment nor live end-to-end verification
is established by these database checks. Replay was previously tested only in
disposable local PostgreSQL fixtures. The workspace runtime is not proof of
the verified destination schema.

The server refuses enablement until the full schema readiness function succeeds.
Default-off saves remain compatible with an unmigrated database.

## Verification and its limits

Isolated verification covers both handlers' free and paid completion, authorized
and cancelled payment exclusion, enabled Invoice/PO exclusion, independent
purchaser/attendee identities, mixed policies, role and identity conflicts,
normalization/wildcard handling, tenant isolation and eligibility failures.
Database fixtures cover real concurrent duplicate insertion, same-purchase
replay, atomic rollback, role-policy conflicts, private grants and booking-batch
replay/seat accounting. Browser coverage interacts with the real shared controls
in a network-blocked fixture; it is not a signed-in live event-editor test.

Commands:

```sh
node scripts/run-isolated-tests.mjs node --test api/_lib/publicTicketMemberCreation.test.mjs api/_lib/publicTicketMemberPurchase.test.mjs api/_lib/publicTicketMemberReleaseGate.test.mjs api/public/public-invoice-po.handlers.test.mjs api/public/ticket-release.handlers.test.mjs
node scripts/run-isolated-tests.mjs node --test api/_lib/publicTicketSimpleQuote.test.mjs api/_lib/publicTicketMemberRecovery.test.mjs
node scripts/run-isolated-tests.mjs --allow-local-postgres node --test api/_lib/publicTicketMemberCreation.postgres.test.mjs
node scripts/run-isolated-tests.mjs node --import tsx --test client/src/utils/publicTicketMembers.test.mjs client/src/components/events/PublicTicketMemberFields.test.jsx
env -i PATH="$PATH" HOME=/tmp node --test scripts/public-ticket-members.browser.test.mjs
```

The existing ordinary non-enabled standard-card-without-intent test is marked
TODO by its original suite. Enabled provisioning adds its own mandatory payment
evidence checks; that legacy path is not evidence of successful provisioning.

After approved deployment, verify migration readiness, both signed-in editors,
published bundle visibility, one sandbox paid/free purchase in each event
system, webhook/return replay, administrator retry and authenticated cron
execution. No live provider settlement or signed-in deployed UI is claimed by
the isolated fixtures. Never run synthetic production purchases without approval.

## Manual deployment handoff

The owner approved deployment only and explicitly waived sandbox testing for
this functionality, requesting release for immediate live testing instead.
This is not authorization for the agent to create real-money purchases.

The Git-backed Vercel production deployment request was rejected because the
requested workspace commit was not present in GitHub. No deployment was
created by that request. The workspace branch is ten commits ahead of its
GitHub branch, including unrelated renewal and Canvas changes.
The owner subsequently instructed: "I will deploy manually please do not auto
deploy to git hub." Do not push to GitHub or initiate further deployments.
Deployment is now an owner-managed handoff, not an outstanding agent action.
Database readiness remains verified;
published bundles, signed-in editors, replay, administrator retry and
authenticated cron execution are not yet verified for this release.

The completed scope is approved destination migration application and database
verification. Sandbox purchases were waived by the owner; post-deployment live
checks remain unverified and must not be represented as passed.
