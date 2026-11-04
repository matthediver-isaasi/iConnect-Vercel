# Survey lifecycle rollout

## DEST application — 4 November 2026

Applied with explicit owner approval to verified DEST project
`lvmzliemqnieeoruhkik`. Migration SHA-256:
`2cbbdb2f7173022e9a1ecc27c56055217245cd8d23d51a28b6dd14d12c2a07cd`.
All 76 documented regression tests passed before application.
PostgREST schema reload was requested after commit.

Verified service-role-only lifecycle RPC execution, RLS on both private
tables, no browser read grants and no direct service-role insert grants.
The affected webinar survey and assignment row fingerprints were unchanged.
Its remove-assignment impact preview succeeded under `service_role`; that
verification transaction was rolled back, including its confirmation token.
No survey removal, response change, publication or email was performed.
Signed-in browser flow and production application revision were not verified.

## Release boundary

The application changes require `supabase/migrations/202612310040_survey_lifecycle.sql`.
Do not treat a successful frontend build as proof of the live database rollout.
Apply only to the documented DEST project after explicit owner approval.
No live migration, survey transition, publication, or email send is part of the
implementation tests.

The migration does not update existing survey rows or automatically publish
drafts. Legacy inactive, archived and draft combinations retain their availability.
New confirmations and audit records are service-private. The service role cannot
directly edit their tables; the scoped RPC owns writes.

## Behaviour

- Survey lifecycle and event attachment are separate.
- Configuration saves retain the current live publication. Draft changes are
  identified separately.
- Publish retains the existing snapshot implementation, serialized with lifecycle
  changes. Publishing a paused or closed survey does not reactivate it.
- Restore moves an archived survey to paused; activation is a separate action.
- Removed assignments retain their token, responses and historical relationship.
- Restoring does not extend invitation expiry, reopen an elapsed response window,
  override form access policy or reset completion records.
- Deletion requires an unused survey without assignments, responses, completions
  or published snapshots; database dependencies remain a final protection.
- A confirmation is bound to the administrator, tenant, action, configuration and
  dependency counts. Changes require a fresh impact review.
- Existing generic archive, assignment mutation and form-availability writes are
  rejected. Ordinary non-survey form archiving is unchanged.

## Verification

Run the lifecycle PostgreSQL test with the disposable local harness, not DEST:

```
node --test api/_lib/surveyLifecycle.postgres.test.mjs \
  api/_lib/formArchive.test.mjs api/_lib/surveyAssignment.test.mjs \
  api/_lib/campaignEventSurvey.test.mjs api/_lib/certificateSurveyGrants.test.mjs \
  shared/surveyCompletionPolicy.test.mjs client/src/lib/surveyLifecycle.test.mjs \
  client/src/components/surveys/SurveyLifecycleDialog.test.mjs \
  client/src/components/surveys/AssignmentVersionNotice.test.mjs
```

Tests include stale confirmations, actor/tenant separation, replay refusal,
submission serialization with pause, historical response retention, unchanged
republishing, and keeping paused surveys paused when publishing.
Mounted component tests exercise acknowledgements, deletion checks, stale-token
handling and matching assignment configuration in preview and confirmation.

After approved migration, verify grants/RLS and the live catalog read-only.
Preview and history are safe verification endpoints; do not execute a real
lifecycle change merely to test the deployment. Use a separately approved test
survey for signed-in end-to-end checks.

## Backout

Do not roll back application code alone after this migration: older screens
would attempt writes the new database guards intentionally reject.
Retain the new guards and roll forward with a correction, or prepare a separately
reviewed database backout together with the matching application release.
Never delete confirmations, audit history, responses or retained assignments as
part of a backout.
