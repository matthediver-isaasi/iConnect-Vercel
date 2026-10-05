# Due Diligence swap verification

Verified 2026-10-05 against DEST (`lvmzliemqnieeoruhkik`) using read-only Supabase requests.

The user confirmed the source ID from the UI as
`cd9d18f1-4d7d-4374-b486-8f1d92ad10f7`, not the malformed identifier originally reported.
The tenant-scoped source and target ESO Long form
`a9ec1559-495a-4705-9da9-d51517be7bb6` were inspected.

## Reproduction and result

The locked `org:name` organisation dropdown has an unchanged stale UUID in the
original/reviewed snapshots. That organisation no longer exists. In contrast,
the persisted raw submission answer equals its persisted organisation linkage.
The old mapping fails the shared validator's `Invalid organization selection`
branch. This is not evidence that reviewer ownership caused the incident.

Preparation recovers only this narrowly evidenced case: a single locked identity
field on each form, unchanged original/reviewed UUID, raw answer equal to the
same-tenant submission linkage, and no record existing for the stale UUID.
The replacement reference must still pass tenant, organisation eligibility,
conditional and relationship checks. No organisation writes or creation
exemptions are granted. Names and object-shaped legacy answers are not guessed.

The target Applicant email is a custom field where the source is an email
field. Compatibility uses tenant-scoped preference metadata rather than treating
all custom fields as interchangeable.

The final real-data **preparation-only** check returned `canSwap: true`, no
problems, and one applicant-reference recovery. No live swap handler was invoked.
Historical answers were not changed.

## Verification

- `node scripts/run-isolated-tests.mjs node --test api/due-diligence/swapExecuteRelationship.test.mjs api/_lib/formRelationshipOptions.test.mjs api/_lib/bnmsJuniorV2Relationships.regression.test.mjs api/public/form-submission.repeatable.test.mjs`
  — 119 tests passed, including endpoint side-effect assertions, Other responses,
  option ID/number normalization, long-text aliases, nested repeatable schemas,
  and BNMS ownership protections.
- `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=$(which chromium) npx playwright test --config=tests/dd-swap.config.mjs`
  — two isolated dashboard browser tests passed (confirmation and blocked preview).
  Default downloaded Chromium cannot launch in this workspace because its shared
  libraries are unavailable; the installed Nix Chromium works.
- Workflow restarted and served on port 5000. The unauthenticated screenshot
  cannot verify the signed-in dashboard; the browser tests use mocked,
  isolated auth/API responses and do not establish a deployed user session.

No schema migration was needed or applied to any database. SOURCE was not used
as incident evidence. No live submission/archive/contract changes, workflow
messages or deployment occurred. Deployment requires separate confirmation;
the actual signed-in production flow remains unverified.
