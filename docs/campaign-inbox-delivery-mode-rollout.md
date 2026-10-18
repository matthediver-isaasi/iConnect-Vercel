# Campaign test-mode inbox exclusion

## Change

Campaign recipient submission mode is recorded before Mailgun is called, using
the final envelope's `o:testmode` value. Once recorded, it is immutable. Retries
use the recorded mode rather than a subsequently edited campaign flag.
Preparation alone does not record a mode. A deadline expiring after the write
but before submission leaves the mode pinned for a safe retry.

Only recipients with `sent_at` and `delivery_is_test = false` appear in the
service-only `campaign_inbox_recipient` view. Lists (including folders, archives,
pins and favourites), search, detail/auto-read and state-update authorization
use that view. All IDs in a bulk selection are checked before any source is
mutated. Missing schema fails closed; there is no base-table fallback.

Unread polling uses `campaign_inbox_unread_summary(uuid,uuid)`, a service-only,
security-invoker aggregate over the same eligible relation. Its scoped anti-join
ignores read/archive states for test, unsent, orphaned and other-tenant rows,
while counting eligible recipients without any state as unread. Count and latest
campaign preview are computed together without transferring all recipients.

Mailgun dry runs still submit `o:testmode=yes` and retain accepted statuses,
timestamps and identifiers. Explicit **Send Test Email** to a chosen destination
still makes a real delivery to that destination without classifying or updating
the source campaign recipient. Transactional messages, project notifications,
consent and admin reports have not been changed.

## Migration and verified target

Required migration:
`supabase/migrations/20261018_campaign_inbox_delivery_mode.sql`

Runner:
`scripts/apply-campaign-inbox-delivery-mode.mjs`

The runner pins both the REST project and SQL connection identity to destination
Supabase **`lvmzliemqnieeoruhkik`**, uses verified TLS, and never selects SOURCE or
the generic runtime database connection.

The read-only preflight for this implementation verified that target and found:

| Check | Observed |
| --- | ---: |
| Existing campaign test-mode column | Present |
| New recipient provenance, view and summary | Not installed |
| Historical recipient rows on currently test-marked campaigns | 15,732 |
| Historical recipient rows on currently live-marked campaigns | 202,132 |
| Historical recipient rows on campaigns with NULL flag | 0 |
| Campaigns currently sending/preparing | 1 |

Historical counts include rows with a sent timestamp, a provider identifier, or
processing status. They are current-flag evidence, not proof of the original
provider mode for every historical send.

**Application status:** migration tested on disposable local PostgreSQL only.
It has **not** been applied to DEST, SOURCE or any other shared database. No real
recipient sends or production deployment were performed. Read-only preflight
does not establish deployed behavior.

## Historical limitations

The idempotent backfill classifies only unrecorded historical submitted/in-flight
rows from `email_campaign.is_test_mode IS TRUE`. False and legacy NULL campaign
flags become live (`false`); pending unsubmitted rows remain unclassified. Repeat
runs never overwrite recorded mode, even after campaign edits. Recipient rows,
Mailgun identifiers and inbox state are preserved.

If a campaign flag changed **before** the first backfill, that original mode
cannot be recovered from the current flag. Names and subjects are not evidence.
Do not claim the backfill resolves those ambiguous cases. Any future correction
needs independent provider/audit evidence and a separately approved, narrowly
scoped repair; the normal immutable-mode guard deliberately prevents casual
reclassification.

## Coordinated rollout (pending operator approval)

1. Quiesce campaign entry points and scheduled/resume workers; wait for in-flight
   invocations to finish. The runner's active-status check is an extra guard, not
   a substitute for quiescing workers.
2. Run the default read-only preflight:
   `node scripts/apply-campaign-inbox-delivery-mode.mjs`.
3. With approval and the target verified, run:
   `node scripts/apply-campaign-inbox-delivery-mode.mjs --apply`.
4. Deploy/merge through the normal release process while sending remains paused;
   ensure all sender workers and inbox handlers use the new code. The migration
   must precede the handlers. Old workers must not resume after backfill: they
   cannot record send-time mode. New handlers intentionally fail closed until
   the schema is available, and unknown-mode deliveries remain hidden.
5. Verify the REST schema reload exposes the view's campaign relationship and
   summary RPC; then verify signed-in inbox list/search/details/state actions,
   unread badges and login previews on the deployed environment using controlled
   test accounts. Do not send to real audiences as a verification shortcut.
6. Resume workers only after those checks. Preserve history and existing state.

## Verification

Provider-free transport/worker tests (199 passing):

```sh
node scripts/run-isolated-tests.mjs --shell "node --test api/_lib/campaignDeliveryProvenance.test.mjs api/_lib/campaignBulk*.test.mjs api/_lib/campaignService*.test.mjs api/_lib/emailService*.test.mjs api/_lib/campaignEntryPointTransport.test.mjs api/_lib/campaignEventSurvey.test.mjs api/_lib/campaignAttendeeContent.test.mjs api/_lib/eventEmailSponsors.test.mjs"
```

Mocked HTTP handlers (32 passing):

```sh
node scripts/run-isolated-tests.mjs node --test api/communication/inbox/campaign-eligibility.test.mjs
```

Real SQL on disposable PostgreSQL (1 passing):

```sh
node scripts/run-isolated-tests.mjs --allow-local-postgres node --test api/_lib/campaignInbox.postgres.test.mjs
```

The SQL test covers replay, immutable modes, current/legacy flags, accepted
reconciliation, scoped/orphan/unsent states, stateless unread, more than 1,000
recipients and browser-role denial. Handler fixtures exercise every state action,
mixed-source rejection before writes, pagination, ownership, missing schema and
unchanged transactional/project paths. These checks do not verify signed-in
production rendering or reconstruct missing historical evidence.

The application workflow restarted successfully on port 5000. An anonymous
preview capture returned the existing `Tenant not found` error for the workspace
tenant mapping, so signed-in inbox UI rendering was **not verified**. No auth
bypass or database-target change was introduced to work around that limitation.
The existing inbox alert-preferences regression and destination-target guard
tests also passed (3 additional tests; 235 passing checks in total).
