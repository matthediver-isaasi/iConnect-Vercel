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

## Production application attempt — 2026-10-18, blocked safely

**Application status: NOT APPLIED.** The user authorized this migration on DEST,
but the fresh preflight still found an active campaign and sender coordination
was not established. `--apply` was not invoked. No production deployment,
campaign pause/resume, status edits, schedule changes, sends, or database writes
were performed. SOURCE was neither queried nor changed.

Approved file: `supabase/migrations/20261018_campaign_inbox_delivery_mode.sql`
(SHA-256 `7aa06876a6a97368713d9aa274bcee38d33701826441e65a186499766fa27fa3`).
The existing runner verified the REST and SQL identities for DEST
`lvmzliemqnieeoruhkik`, connected with certificate and hostname verification,
and completed its default read-only preflight at approximately 15:19 UTC.

### Refreshed baseline

A separate destination-pinned, verified-TLS, repeatable-read/read-only
transaction observed the following at **2026-10-18 15:19:48 UTC**. These are
point-in-time baselines, not post-migration verification or a sender freeze.

| Check | Observed |
| --- | ---: |
| Campaign records | 145 |
| Recipient records | 219,580 |
| Member inbox message-state records | 1,404 |
| Recipient rows with provider identifiers | 217,858 |
| Recipient rows with sent timestamps | 217,858 |
| Historical evidence rows on currently test-marked campaigns | 15,732 |
| Historical evidence rows on currently live-marked campaigns | 202,132 |
| Historical evidence rows on NULL-flag campaigns | 0 |
| Sent rows on currently test-marked campaigns | 15,730 |
| Sent rows on currently live-marked campaigns | 202,128 |
| Sending campaigns | 1 |
| Preparing / scheduled campaigns | 0 / 0 |

The sending campaign was currently test-marked, with 4,992 recipient records,
4,315 sent timestamps, two processing recipients and zero pending recipients.
Its latest campaign update was 2026-10-12 18:40:27 UTC. The old timestamp does
**not** prove that worker invocations have drained or authorize changing its
status to bypass the guard.

The campaign test-mode column exists. The recipient delivery-mode column,
eligibility view, immutable-mode trigger and guard function, partial index, and
unread-summary function are all absent. Non-mutating service-role REST GETs
confirmed the missing relation (`404 / PGRST205`, including the intended
`email_campaign!inner(tenant_id)` selection) and summary RPC (`404 / PGRST202`,
using nonexistent UUID arguments). Thus service-only grants, relationship
inference, actual test exclusion, live eligibility and unread totals cannot yet
be verified in production.

### Deployed version and scheduling evidence

Read-only Vercel API responses identified project
`prj_iPFlb9rOOVNVtbobMRR1vyV934lf` (`vite-migrate-replit-6`) and its READY
production deployment `dpl_HJNe6JhxZbP5LKUHwdKcDUVKNC2N`.
Its Git source is repository `1104295583`, branch `emsFast`, commit
`4aae9843359689e09b42b70db999538c5f9d7781`.
The production aliases include `iconn.app`, `www.bnms.org.uk`, and
`www.graduatefutures.org`.

Vercel's active cron configuration targets that same deployment, with
`/api/email-campaigns/process-scheduled` enabled every minute (`* * * * *`);
`disabledAt` was null. No scheduled or send endpoint was invoked.
Inspection of the exact deployed Git commit confirmed:

- All four inbox handlers still query the base recipient table.
- The new campaign inbox and delivery-provenance helpers are absent.
- The sender service has no `delivery_is_test` or provenance-persistence calls.
- The merged feature commit is not an ancestor of that production commit.

This establishes that the identified production deployment and its scheduled
worker do not contain the new implementation; merging the feature did not
complete this rollout. Other possible preview/resume callers have not been
established as quiescent. An anonymous capture of the provider-confirmed
`https://iconn.app` alias displayed the normal platform landing/sign-in page.
Signed-in inbox behavior was **not verified**.

### Exact remaining operator requirements

1. Coordinate and approve a campaign-only sending freeze covering manual starts,
   preparations, scheduled execution and resume/self-triggered invocations,
   including any other deployment that can reach DEST. Let genuine in-flight
   work finish; investigate the two processing rows if they do not drain. Do not
   edit campaign statuses just to make the runner pass.
2. Confirm that the freeze is effective and arrange the normal authorized release
   of the matching sender and inbox code while sending stays frozen. This task
   does not authorize a production code deployment or disabling unrelated jobs.
3. Refresh all preflight/baseline observations and apply the unchanged migration
   with the pinned runner only once its active-campaign guard and the independent
   coordination prerequisites are satisfied.
4. Verify committed schema, full service-only permissions, REST relationship/RPC,
   retained history/state, live eligibility and test exclusion from both the view
   and unread summaries. The sent-test baseline is 15,730, not the broader 15,732
   evidence-row count; neither count proves original provider mode.
5. Verify the actual production and scheduled-worker versions plus controlled
   signed-in inbox behavior before the operator resumes work.

The migration remains outstanding on DEST. Its intended effect is to **hide**,
not delete, historically classified test deliveries. No historical messages have
been hidden by this attempt, and the current-flag classification limitations
above remain unchanged.

## Coordinated rollout (migration approved; sender/release coordination outstanding)

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
