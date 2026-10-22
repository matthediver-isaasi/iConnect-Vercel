# Campaign delete timeout: evidence and rollout

## Live read-only inspection — 2026-10-22

The existing destinationTarget validator verified REST and SQL project pins for
DEST (`lvmzliemqnieeoruhkik`), with verified TLS and the Supabase public CA.
All live queries ran in READ ONLY transactions with an 8-second statement budget.
SOURCE was not queried or changed. No production delete or mutating EXPLAIN ran.

Graduate Futures Institute / Annual Conference 2026 (test):
- Campaign `a3307a71-bd43-4817-8cdc-eb6f578026dd`,
  tenant `fd82da65-aab7-4a5c-85b8-b2febeb2003d`.
- Sent, unarchived; 14 actual recipients (stored total 13).
- Recipient states: 5 opened, 4 clicked, 5 delivered.
- 81 email events, 16 link clicks; zero campaign unsubscribe rows, survey
  deliveries, preparation rows or test-send leases.
- These are observations, not permission to delete or guarantees of future eligibility.

Installed lifecycle, idle-check and parent-guard function bodies match
202612310006_campaign_lifecycle.sql exactly. Installed FK actions match the
source graph (recipient cascade, event SET NULL, survey NO ACTION, consent
SET NULL). Parent deletion triggers the lifecycle guard; installed recipient
custom triggers are INSERT/UPDATE only, and event triggers INSERT only.

`authenticator` has statement_timeout=8s and lock_timeout=8s. No lock wait was
observed in the activity snapshot. That cannot rule out a lock at incident time;
historical incident lock/trigger timing was not available.

## Measured bottleneck

DEST is missing both idx_email_event_recipient and
idx_email_link_click_recipient, despite the original table migration declaring
them. Campaign indexes exist, but cannot support per-recipient FK actions.
Every cascaded recipient deletion therefore scans unrelated tenants' history
to enforce these foreign keys. This is scanning, not evidence of cross-tenant writes.

Read-only EXPLAIN (ANALYZE, BUFFERS) of a single recipient lookup:
- email_event: parallel sequential scan, 3,773.856 ms, 92,551 blocks read,
  4,450 hit (excluding the recipient lookup), 5 results.
- email_link_click: parallel sequential scan, 56.739 ms, 13,171 blocks hit,
  1 result.

Table statistics estimated 553,767 event rows. Actual scan rows indicate roughly
566,437 events and 264,013 clicks; statistics are approximate/stale, not exact counts.
Repeated event scans alone explain how a small campaign can exceed 8 seconds.
No destructive measurement was performed on DEST.

## Correction

New migration 202612310007_campaign_delete_fk_indexes.sql restores only these
two ordinary btree indexes. It does not replace functions, alter grants, change
foreign keys, bypass locks, cancel delivery, release leases, or raise request
timeouts. The existing atomic delete and group-draft path remain authoritative.

Confirmed SQLSTATE 57014 now returns HTTP 503 with retry guidance and the original
code. Both admin and group-draft deletion preserve it. The UI keeps the campaign
and dialog after failure and only invalidates queries after explicit success.
Unconfirmed responses do not claim deletion succeeded.

## Verification

`node --test scripts/campaign-lifecycle.postgres.test.mjs scripts/campaign-delete-timeout.test.mjs scripts/apply-campaign-lifecycle.test.mjs`
passed all four tests (the PostgreSQL test contains the full lifecycle assertions).
Disposable local PostgreSQL only, using real lifecycle/preparation/survey DDL:
- 400 recipients, 550,000 unrelated events with payloads, 265,000 unrelated
  clicks, plus recipient history and inbox state.
- Missing indexes: deletion timed out with 57014 after 8,001 ms.
- Restored indexes: identical atomic lifecycle deletion as service_role
  completed in 19 ms under the same 8-second budget.
- Timeout preserved recipients, history and inbox rows; successful deletion
  retained consent and unrelated tenant history.
- Existing empty deletion, archive/restore, protected survey and unexpected-FK
  rollback, test-send reservations, unresolved delivery, concurrent parent
  locking, group draft deletion and service-only privilege checks passed.
- Migration is idempotent; runner rejects incorrect hashes/targets.

`npx playwright test --config tests/campaign-lifecycle-browser.config.mjs`:
5 passed, 1 failed. New timeout test verifies visible guidance, retained row,
retained dialog, no success toast or query invalidation, and explicit successful
retry. Archive/restore, permanent deletion, blocked deletion and missing-schema
tests passed. Existing "outcomes separate exclusions and uncertain sends..."
expects a delivery summary in the table that the current component does not
render there (also absent in HEAD); it is unrelated to this patch and remains
unresolved. No tests were skipped or weakened.

The application workflow restarted and serves on port 5000. The normal preview
shows "Tenant not found" for the workspace host; signed-in production UI was not
verified. Browser checks rendered the actual component with isolated HTTP
fixtures, not live tenant data.

## Rollout status and approval

**Applied:** disposable local test databases only.
**Pending:** DEST migration, subject to explicit production approval.
**SOURCE:** no changes. **Reported campaign:** not deleted or modified.
Application deployment is separate from merging; no deployment performed.

Offline review:
```
node scripts/apply-campaign-delete-indexes.mjs
```
Reviewed SQL SHA-256:
`051bf34517f78f8f9e7676a97f0144276d752c367540a5fa98c9f03013e7709f`

Only after approval:
```
node scripts/apply-campaign-delete-indexes.mjs --apply --review-sha256=051bf34517f78f8f9e7676a97f0144276d752c367540a5fa98c9f03013e7709f
```

Use a low-traffic window: ordinary transactional index creation blocks writes
to each indexed table while building. The runner bounds lock acquisition to
2 seconds and DDL to 120 seconds; both indexes commit together only after
valid/ready, unfiltered leading-column btree verification. Any error rolls back.
These are migration-local budgets, not changes to the existing API budgets.
If the window is insufficient, stop and review a concurrent-index rollout
rather than increasing application timeouts or retrying blindly.

After approved rollout, repeat bounded read-only index/catalog and recipient
lookup plan checks, and confirm the reported campaign remains present.
Deleting the reported campaign still requires separate approval and the normal
guarded API; do not use it as a production benchmark.
