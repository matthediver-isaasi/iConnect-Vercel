# Sales settings conflicts — 2026-11-10

## Evidence and limits

- Requested historical window: 07:55–08:05 UTC, including the reported
  07:59:59.570Z example. Supabase log and SQL connector requests were denied.
  No historical conflict count or production caller attribution is available.
- The existing project-pinned, certificate-verified DEST SQL connection succeeded
  in a `BEGIN READ ONLY` transaction. Inspection of `pg_get_functiondef` confirmed
  the service-only RPC, tenant row lock, expected-version check before update,
  version increment and audit insert. Visibility, naming, billing, task-list and
  partnership extensions are installed. No database defect was found.
- Repository runtime calls all converge on `api/sales/settings.js` through
  `useSalesSettings`. Reads do not write; saves originate in explicit form submits.
  Query retries are disabled and the app has no configured mutation retry loop.
  This does **not** establish which frontend build produced the incident.
- `apply-sales-partnership-terms.mjs` seeds once on first installation under a
  transaction, with a locked version read, and has no retry loop. PostgreSQL
  regression callers use disposable local clusters, not DEST. Neither is proven
  to be the incident caller.

## Changes and reproduction

Catalogue visibility previously allowed submission during an authoritative
refresh. An isolated mounted test holds that refresh pending and submits the
form, reproducing the stale-submission gap. The form now checks readiness and
fetch state both in its handler and button, awaits conflict recovery, and retains
choices when recovery fails. All five settings mutations explicitly disable
retries, even if application defaults later enable them. These are bounded
hardening changes, **not proof that the historical flood is resolved**.

Conflict diagnostics record a server-generated request ID, hashed tenant/actor,
actor type, field names, expected version, and a best-effort observed version.
No settings contents, credentials, raw identity, or request headers are logged.
The observed version may advance after the failed RPC; it is diagnostic only.
Authorization failures are not classified as settings conflicts. Logging and
diagnostic-read failure must not turn a conflict into a retry or success.

## Verification and release

Run focused checks using the isolated runner:

```
node scripts/run-isolated-tests.mjs node --test api/_lib/salesFoundation.test.mjs client/src/components/sales/QuoteTaskSettings.scope.test.mjs client/src/components/sales/BillingSettings.mounted.test.mjs
node scripts/run-isolated-tests.mjs --allow-local-postgres node --test api/_lib/salesFoundation.postgres.test.mjs
```

No migration, production write, version reset or deployment was performed.
Merge/release matching API and frontend together through the normal authorized
process. Signed-in production UI and the deployed frontend version remain
unverified.

After authorized rollout and log access restoration, compare equal ten-minute
windows of PostgreSQL conflict counts and settings PATCH/409 rates. Group
`sales_settings_conflict` events by hashed tenant/actor and expected version:
unchanged versions repeated rapidly suggest stale submissions; advancing versions
and multiple actors suggest competing edits. Correlate request timestamps with
hosting access logs and release metadata to identify the actual client. Direct
RPC callers will not emit API events and require database/access-log correlation.
Do not generate test conflicts in production. Record unavailable counts as
unknown, never zero. Until that evidence exists, incident resolution is unproven.
