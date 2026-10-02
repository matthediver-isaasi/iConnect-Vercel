# GoCardless heartbeat configuration follow-up

## Verified configuration change

On 2 October 2026, the user explicitly approved changing existing Better Stack
heartbeat **486316**, named **GoCardless reconcilliation**, to:

- Expected interval (`period`): **300 seconds**.
- Grace (`grace`): **900 seconds**.
- Server timezone (`server_timezone`): **null**, separately approved.

The initial interval/grace-only PATCH was rejected with HTTP 422 because the
existing Europe/London server timezone requires a period of at least one hour.
After separate approval to clear that optional daylight-saving adjustment, the
PATCH succeeded. An independent GET verified the three settings.
Better Stack's update timestamp was **2026-10-02T16:39:24.961Z**.
Only `period`, `grace`, `server_timezone`, and `updated_at` changed.
The monitor remained **down**. Notification settings were not changed.

## Incident evidence

Authorized Better Stack API reads found incident **1017300004** linked to
heartbeat **486316**, beginning **2026-09-18T12:15:50.790Z** with cause
**Reported failure**, status **Started**, and no resolution timestamp.
This establishes reported failure at incident onset, rather than merely a
missing heartbeat. It does not establish delivery of each subsequent heartbeat
or rule out delivery failures during the same incident.

The heartbeat metadata response did not contain individual receipt timestamps.
A receipt-by-receipt ledger and post-correction automatic recovery remain
unverified. No manual heartbeat request or incident dismissal was performed.

## Vercel evidence and remaining deployment boundary

Repairing the existing Vercel integration restored exact project/team reads.
The previously verified READY production deployment was
`dpl_7Z9W5FCbeML5fGP5Jo2ANoheMJdC`, commit
`7ed581b2ee2b0436dd98ff6935cc4ee7d1ca9c57`.
Its deployment metadata included `/api/cron/reconcile-gocardless` with
`*/5 * * * *` and the name
`BETTERSTACK_HEARTBEAT_GOCARDLESS_RECONCILIATION_URL`.
The project variable is sensitive and production-scoped.

The user reported correctly updating that variable after discussion of its
normal GoCardless-only monitor mapping. This is operator-supplied configuration
evidence, not an independent comparison of the sensitive stored value.
No secret value is retained in this document.

At the initial follow-up check, the project's production target pointed to a new deployment,
`dpl_DSpALCm2CzqLtRw7uzyDYqoXbtXg`, created
**2026-10-02T16:38:42.092Z**, using the same commit. Its deployment detail endpoint
still reported **BUILDING**. Therefore it must not yet be described as the active
READY deployment. The project cron definition still reported the five-minute
schedule; the building deployment response did not establish the updated
environment's presence in a completed runtime.

### Post-deployment check at approximately 17:04 UTC

The deployment detail endpoint now confirms
`dpl_DSpALCm2CzqLtRw7uzyDYqoXbtXg` is **READY**, target **production**, with
readiness timestamp **2026-10-02T17:01:11.615Z**. Its commit remains
`7ed581b2ee2b0436dd98ff6935cc4ee7d1ca9c57`. Deployment metadata includes the
GoCardless heartbeat variable name and the `*/5 * * * *` cron. Variable-name
presence does not independently reveal or compare the sensitive value.

At **2026-10-02T17:04:26.762Z**, authorized Better Stack reads still showed
monitor **486316** down, with period 300, grace 900, and server timezone null.
Incident **1017300004** remained Started with no resolution timestamp.

A bounded read-only HTTPS REST query to the hostname-pinned DEST project
`lvmzliemqnieeoruhkik` selected the six latest scheduled reconciliation records.
JSON-string details were decoded. All six were partial and contained provider
404 / Resource not found errors:

| Executed at, UTC | Errors | Repaired | Skipped |
|---|---:|---:|---:|
| 2026-10-02 17:03:30.816 | 4 | 0 | 72 |
| 2026-10-02 16:56:07.451 | 5 | 0 | 19 |
| 2026-10-02 16:51:04.222 | 4 | 0 | 12 |
| 2026-10-02 16:45:57.097 | 4 | 0 | 9 |
| 2026-10-02 16:41:00.047 | 5 | 0 | 10 |
| 2026-10-02 16:35:53.431 | 4 | 0 | 6 |

The latest recorded completion is after deployment readiness. Audit timestamps
are not deployment/request correlation IDs, so they do not independently prove
which deployment began that invocation. No manual run was requested.
This is evidence of ongoing reconciliation failure, not recovery. The sampled
metadata does not establish exact cohort identity or individual heartbeat
delivery. No change to the underlying reconciliation correction was made here.

Remaining verification:

1. Establish that the underlying reconciliation correction is deployed; the
   monitor change is not that correction.
2. Correlate naturally scheduled run outcomes with authorized receipt history
   and automatic incident recovery, respecting per-row retry backoffs.

At that stage recovery was not complete. Subsequent owner-approved cleanup and
natural-run recovery are recorded below.

## Read-only assessment of deleting the four sandbox-labelled plans

After the user requested verification before a potential test-data cleanup,
reads against pinned DEST used verified TLS and explicit read-only transactions,
with a 20-second statement timeout. No cleanup script or billing endpoint ran.
The cohort is the four plan IDs listed in the original diagnosis.

Current findings:

- Four active plans, four active agreements, and four payments marked `paid_out`
  all have local environment `sandbox`. These are stored application labels
  and statuses, not proof of provider environment or live settlement.
- Four member-membership-history records reference the agreements. All are
  active with payment status `partial`. None currently has a Xero invoice ID
  or accounting invoice ID; absence of those links is not proof that no external
  accounting side effect ever occurred.
- Three payment records have accounting status `failed` with retained HTTP 429
  evidence; one has accounting status `skipped`.
- Installed single-column foreign keys into the plan, agreement and payment
  tables were enumerated and their actual cohort dependencies counted.
  There were no composite foreign keys into those three tables.
  Nonzero dependencies were the four plans referencing their agreements,
  four payments referencing plans, and four membership histories referencing
  agreements. Those constraints use NO ACTION, not cascading deletion.
- All other inspected direct foreign-key dependencies were zero, including
  refunds, retries, cancellation requests, invitations, renewals, dynamic
  reservations/completions, manual collection authorizations, adoption/release
  records and arrears tables. In particular, the cascade-capable arrears tables
  had no rows for this cohort at the read snapshot.
- Twenty non-FK status-history records also refer to the cohort: eight plan
  transitions and twelve agreement transitions, all sourced from webhooks.
  This inspection is not an exhaustive search of every soft/JSON reference.
- Twenty-eight retained GoCardless webhook events directly match the cohort's
  subscription, mandate and payment resource IDs. They all carry the same
  provider organisation ID. They include subscription creation, mandate
  submission/activation and payment creation/submission/confirmation.
  Their payloads contain no `sandbox` or `test` marker. Metadata identifies
  local plan/agreement/tenant links, not environment or signing-secret
  provenance. The provider account therefore remains unclassified as live
  versus sandbox by this evidence alone.

**Initial decision before owner confirmation:** no deletion was performed or established as safe. Deleting the
plans/payments/agreements is not an isolated four-row removal, and membership
history must not be deleted merely to bypass the agreement foreign keys.
The next prerequisite is provider-origin sandbox account evidence for the
exact resources (a read-only sandbox-account lookup or sanitized dashboard
export), followed by a reviewed cleanup scope. No GoCardless provider request
was made as part of this database assessment.

## Safety and migrations

No billing/cron endpoint, provider retry, or heartbeat reporting URL was invoked.
No incident was acknowledged or dismissed, and no error predicate was changed.
The agent did not initiate a production deployment or edit Vercel variables.
No database migrations were needed or applied. The investigation above was
read-only; the subsequently approved data cleanup is recorded below.
The disclosed heartbeat URL should be rotated through separately approved
configuration work; rotation has not been independently verified.

## Subsequently authorized test-data cleanup

The owner explicitly confirmed that these four anonymised accounts were
“100% tests”, then separately approved deleting exactly four plans, four payments,
four agreements and four membership-history rows, preserving audit/webhook
history and performing no provider operation. This expanded the original
monitoring-only scope. It is owner-attested test purpose, not an independently
verified GoCardless account-environment mapping.

The cleanup committed on verified DEST `lvmzliemqnieeoruhkik` at
**2026-10-02T17:21:49.206Z**:

| Table | Deleted rows |
|---|---:|
| `membership_payment_plans` | 4 |
| `gocardless_payments` | 4 |
| `membership_billing_agreements` | 4 |
| `member_membership_history` | 4 |

Installed DELETE triggers and rules were inspected first. The transaction
locked the four tables against concurrent writes, locked the exact selected
rows, rechecked tenant/environment/anonymised-member identity and absent invoice
links, and rejected any foreign-key dependent row outside the approved set.
All sixteen deletes committed together. Existing guards were not disabled.
The initial preflight attempt rolled back before deletion because a dependency
table has no `id` column; the corrected check counts external dependencies
without assuming that column exists.

No member identity, mandate, customer, webhook event, or status-history row was
targeted. No provider cancellation or other provider operation was performed.
An independent read found zero remaining plans among the four approved IDs.
The narrowly pinned runner is
`scripts/cleanup-confirmed-gocardless-tests.mjs`; it refuses a missing/changed
cohort and commits only with `--apply`. Do not reuse it for other records.

## Verified natural-run recovery

Two naturally scheduled runs after the cleanup completed successfully:

| Executed at, UTC | Status | Errors | Repaired | Skipped | Duration |
|---|---|---:|---:|---:|---:|
| 2026-10-02 17:25:49.904 | success | 0 | 0 | 4 | 7,647 ms |
| 2026-10-02 17:31:12.268 | success | 0 | 0 | 6 | 29,897 ms |

Better Stack automatically resolved incident **1017300004** at
**2026-10-02T17:25:50.327Z**, immediately after the first successful completion.
At **17:31:30.896 UTC**, monitor **486316** remained **up**, with period **300**
and grace **900**, and the incident remained **Resolved**.
The original cause remained **Reported failure**.

This correlates successful scheduled reconciliation with provider-recorded
automatic recovery, without a manual heartbeat, incident dismissal, billing
invocation, or error-predicate change. The API reads establish incident onset
and recovery, not a full receipt-by-receipt historical delivery ledger; they
cannot rule out individual delivery failures during the earlier incident.
The zero repaired counts do not prove new collections or accounting settlements,
and the short observation window does not exhaust one-hour per-row backoffs.

The observed incident is recovered. Cleanup was based on the owner's explicit
test-data identification and exact deletion approval, not a broader fix to
environment/account routing. Preventing future cross-environment reconciliation
and verifying rotation of the previously exposed reporting URL remain separate
follow-ups. No migration is outstanding for this work.