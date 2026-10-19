# Campaign archive and permanent deletion

## Rollout status

Implementation and isolated verification are complete. **The migration was
applied to verified DEST on 2026-10-19 following the user's request to enable
archive/delete. No SOURCE or DEST campaign was archived, restored, deleted or
sent as verification. No deployment was performed.**

Required migration: `supabase/migrations/202612310006_campaign_lifecycle.sql`.
Its intended application target is **DEST only**, project
`lvmzliemqnieeoruhkik`. The workspace's legacy SOURCE database is not a substitute.
Live REST readiness returned true and campaign summary reads succeeded. GFI's
99 campaigns and 196,468 recipient records remained present, with no archived
campaigns. SOURCE was untouched. The migration also passed disposable PostgreSQL
tests for atomic deletion, preservation, delivery guards and permissions.

Review the migration and obtain explicit approval before applying it. The
offline runner prints the current SHA-256 without opening a connection:

```sh
node scripts/apply-campaign-lifecycle.mjs
```

After approval, use `--apply --review-sha256=<approved-hash>` on that same runner.
It independently pins the REST project, SQL host and database username, uses
verified TLS, and applies/verifies the migration in one transaction.
The reviewed implementation SHA is
`f4be05d8b3dd50d78883982f25084424e1bc9800b6b456b79bddac64c7457ec8`.
Re-review if the offline hash differs.

**Apply the schema before enabling/deploying the matching application code.**
Archive mutations explicitly check readiness; absent database support never
authorizes a successful lifecycle operation. Ordinary list/statistic reads
remain independently available through narrowly scoped legacy compatibility. Workers also
require the archive column. A normal source merge/deployment does not install
this external database migration.

## Retention and delivery

Archive hides a campaign from the default Active list, without changing its
delivery status. Archived previews, detailed recipient statistics and
campaign-backed member inbox messages remain available. Restore clears archive
metadata only; it does not send, resume or schedule delivery. Duplication drops
archive and previous delivery/preparation metadata and creates a draft.
Archived content is immutable at the database boundary, including legacy generic
edits and edits racing an archive. Late tracking counters and category-deletion
safety maintenance remain writable. The group draft-delete path applies only
to unarchived drafts; archived deletion requires the tenant-admin lifecycle flow.

Overall metrics use all tenant campaigns, independent of archive filters, list
search, pagination or list limits. Only campaigns with `status = 'sent'`
contribute delivery/open/click totals. The denominator and recipient-status
definitions match the previous live-enrichment calculation. Deletion removes
the campaign's contribution; archive/restore do not.

Permanent deletion is an atomic parent-first operation. It removes owned
recipient/click/preparation data and matching campaign-backed inbox state.
Unsubscribe and audit records survive with their deleted-campaign references
cleared. Member records, inbox folders and unrelated transactional inbox messages
are not deleted. Survey-delivery provenance blocks deletion and recommends
Archive; invitations, credentials and responses are not deleted.

Active scheduled/preparing/sending/paused campaigns and unresolved recipient,
preparation or provider work cannot be removed. Stop delivery through the
existing controls and reconcile unresolved work before trying again. Removal
does not perform automatic cancellation or provider calls.

Test email sends reserve the campaign across the provider call. Successful
completion releases the reservation. Failed/ambiguous/crashed sends retain it;
an operator must establish provider completion and explicitly release the
matching tenant/campaign/lease using the service-only
`campaign_test_send_end` RPC. Do not expire a lease or rerun a test send merely
because it is old. There is no new automatic reconciliation or admin lease
management screen.

## Verification

All mutation evidence comes from fixtures or disposable local databases:

```sh
node scripts/run-isolated-tests.mjs node --test \
  api/email-campaigns/lifecycle.test.mjs \
  api/email-campaigns/categoryDeletionSafety.test.mjs \
  api/_lib/campaignService.concurrency.test.mjs \
  api/_lib/campaignEntryPointTransport.test.mjs \
  api/_lib/campaignTransportPayload.test.mjs \
  api/_lib/campaignSenderValidation.test.mjs \
  api/_lib/campaignAttendeeContent.test.mjs \
  api/_lib/campaignRecipientClaims.test.mjs \
  api/member-campaigns/authorization.test.mjs \
  client/src/components/EmailCampaigns.lifecycle.mounted.test.mjs

node scripts/run-isolated-tests.mjs --allow-local-postgres node --test \
  scripts/campaign-lifecycle.postgres.test.mjs \
  scripts/apply-campaign-lifecycle.test.mjs

npx playwright test --config=tests/campaign-lifecycle-browser.config.mjs
npm run build
```

The PostgreSQL fixtures use the actual base campaign and preparation migrations,
including the preparation identity/resume guard, and actual survey-delivery
DDL. Related survey invitation/credential/response dependencies are realistic
restrictive-FK fixtures, not the complete certificate-submission application.
Coverage includes authenticated-role grants, wrong-tenant no-op, survey
retention, unsubscribe/audit retention, inbox cleanup, unexpected-FK rollback,
summary results beyond the REST row limit, and lock-verified races in both
directions.

The normal preview starts but cannot establish an authenticated tenant session
against the workspace's legacy SOURCE. The signed-in deployed UI has **not**
been verified; intercepted browser fixtures are not deployed evidence.
