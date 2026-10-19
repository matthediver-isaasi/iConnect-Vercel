# Campaign delivery outcomes and preparation lifecycle reset

**Pending migration; not applied to any live database.** Deploying application
code does not install this SQL change. After approval, apply
`migrations/20261020_campaign_preparation_lifecycle_reset.sql` after the preparation
and first-send transport migrations (`20261001`, `20261012`, `20261017`).
No historical campaign, recipient, or preparation snapshot is rewritten.

## Outcome display and consumer trace

The tenant campaign list calls `GET /api/email-campaigns` → `getCampaigns` →
`enrichCampaignCounts`. Its statistics dialog calls `GET /api/email-campaigns/:id?stats`
→ `getCampaignStats`; recipient inspection uses the same endpoint's `recipients`
query. Both now use the exact, read-only delivery summary shown by
`EmailCampaigns.jsx`. `getCampaignSendOutcome` is a worker/batch outcome, not the
list's direct data source; its output reaches shared send feedback.
`POST /api/email-campaigns/:id` with `action: duplicate` calls `duplicateCampaign`.
The member-group list (`GET /api/member-campaigns`) returns the same summary
after its existing tenant/group authorization. `GroupEmailManager` uses it in
the list and statistics dialog; group recipient filters use the same skipped
labels. No group access or delivery permissions are widened.

The supplied 19 October example is covered as an isolated regression fixture:
4,826 sent, 150 excluded (149 suppressed plus one consent exclusion), zero
failed, 15 awaiting reconciliation. It is not a new production query.
Sent includes later bounce/complaint and post-send unsubscribe history; those
events are not recategorized as unsent exclusions. Queued recipients are
separate from processing. Only queued recipients can enable delivery resume;
paused, incomplete preparation can still resume through its existing guarded RPC.

Hard-bounce exclusions are **skipped**, not recalled or cancelled mail.
New bulk exclusions retain the known suppression reason. Older cancelled rows
without a reason are honestly labeled “Skipped — not sent”; their historical
reason is not inferred or backfilled. CSV exports use the same labels/categories.

Processing has no individual claim timestamp in the existing schema. Warnings
therefore explicitly use campaign age (30 minutes), stopped/finished state,
or missing/reliably invalid start evidence—not an invented processing age and
never `completed_at`. The action opens read-only delivery inspection and tells
the administrator to reconcile provider evidence before any resend. It does not
retry, release, or mutate processing recipients.

## Evidence and limits

Both previous `campaign_preparation_begin` definitions copied the campaign into
the preparation snapshot without clearing `completed_at`, `cancelled_at`,
`cancelled_by`, `paused_at`, `paused_by`, or `pause_reason`. That is a confirmed
source-level preservation path: a draft containing obsolete values carried them
into a new preparation.

The task reports a completion timestamp preceding campaign creation. Inheritance
from an earlier campaign is consistent with that anomaly, but current source
alone cannot establish which historical deployment, duplication, import, or
manual edit wrote it. No live database or audit logs were queried for this
implementation. Current duplication already omits the five timestamp/actor
fields; `pause_reason` was the remaining omission identified for the application
change. Do not describe current duplication as proof of the historical writer,
or repair old timestamps on that inference.

## Behavior and verification

Both seven-argument (including its default actor) and eight-argument RPCs clear
the six obsolete fields in the same locked update that starts a **new**
preparation, before recording its snapshot. The seven-argument RPC retains its
existing transport. Both remain service-only and retain tenant, version,
schedule, status, category-review and recipient fencing. The older overload
also rejects an existing generation or transport pin, matching the newer
overload rather than replacing a prior claim. Resume/lease/recipient processing
is unchanged; this is not an authorization to retry uncertain deliveries.

Run only against disposable PostgreSQL through the fail-closed harness:

```sh
node scripts/run-isolated-tests.mjs --allow-local-postgres node --test \
  api/_lib/campaignPreparationLifecycleReset.postgres.test.mjs
```

Coverage includes migration/reapplication with no historical rewrites, both RPC
overloads and grants, reset row/snapshot consistency, stale claims and tenant/
schedule/review/status conflicts, residual recipients, existing generations,
transport validation, rollback on snapshot failure, and competing old/new claims.

Application verification: 134 focused delivery, worker, summary, engagement,
feedback and bounce-label tests; 44 member-campaign authorization tests; 10
isolated Chromium tests across tenant and group campaign interfaces passed.
Browser tests intercept all relevant requests and do not send email. The local
application starts normally, but its unmodified preview reports “Tenant not
found”; signed-in live UI was not verified.

Browser commands:

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=$(which chromium) npx playwright test --config playwright.campaign-delivery.config.mjs
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=$(which chromium) npx playwright test --config tests/task-4739-group-email-manager.config.mjs --output=/tmp/group-campaign-outcomes
```
