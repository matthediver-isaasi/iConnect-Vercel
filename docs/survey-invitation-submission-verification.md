# Survey invitation submission verification

Verified 2026-09-29.

## Read-only deployed evidence

Queried verified DEST project `lvmzliemqnieeoruhkik` through Supabase, not the
workspace's legacy SOURCE database. No production writes or real submissions.

- BNMS “Autumn Meeting Feedback” is active and published. Its current immutable
  snapshot has `response_identity: identified`.
- The assignment has no opening/closing restriction, zero responses, and three
  entitlements, none completed, revoked, or expired.
- Its five credentials across certificate and campaign deliveries are current;
  deliveries are accepted, bookings confirmed, and attendee/event scope matches.
- The deployed nested `create_survey_submission` function excludes
  `communication_finalization_state` from its explicit allowlist and raises
  P0001 on disallowed columns. The application previously sent that field for
  identified responses, including null for invitation submissions.
- The deployed outer invitation RPC calls that nested function unchanged and
  uses generic P0001 for its own fixed eligibility messages too.
- Anonymous execution of the nested RPC is denied; service-role execution is
  allowed.
- A bounded last-24-hours database log count found no matching column-contract
  error. Thus the deployed contract defect is confirmed, but the exact historical
  reported request is not independently identified from logs. No bearer link or
  attendee identity was needed or retrieved.

## Repair

Survey payloads no longer contain ordinary-form communication lifecycle state.
Database allowlists and invitation eligibility/atomicity remain unchanged.
Only exact known invitation conflict messages map to the unavailable/answered
response. Other invitation RPC failures return a safe 500; diagnostics contain
fixed categories, SQLSTATE and non-secret scope IDs, not raw errors or answers.

## Isolated verification

- `node scripts/run-isolated-tests.mjs node --test api/public/form-submission.repeatable.test.mjs`
  — 63 tests passed.
- `node scripts/run-isolated-tests.mjs node --test api/_lib/certificateSurveyGrants.test.mjs`
  — 12 tests passed; email transport is a fixture, not a real send.
- `scripts/test-certificate-survey-grants-sql.mjs` — passed against a newly
  bootstrapped disposable local PostgreSQL database. The script header contains
  the reproducible bootstrap command. It installs the real nested submission
  function rather than a stub, covering both delivery kinds, both identity modes,
  standard/complex bookings, completion, expiry, revocation, concurrency, nested
  answer rejection, rollback and retry.
- Application restarted successfully. Browser preview reached the application
  but showed “Tenant not found”; logs confirm the workspace's legacy SOURCE
  lacks `public.tenant`. This is not successful live survey UI verification.

## Migration and rollout status

No new database migration is required. None was applied to DEST, SOURCE, or any
other live database. No migrations remain outstanding for this fix. Production
application code still requires the normal Vercel rollout; local fixture success
does not prove that rollout. No invitations were reset, no real answers submitted,
and no emails sent.