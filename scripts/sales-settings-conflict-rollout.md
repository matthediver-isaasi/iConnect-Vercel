# Sales settings conflict rollout

## Tested change

`202701220070_sales_settings_http_conflict.sql` changes only the exact
`Sales settings version conflict` exception in the installed
`patch_sales_settings(uuid,integer,jsonb,text,text)` function from `40001`
to `PT409`. It preserves the installed function body, signature, owner and ACL.
Unexpected definitions fail closed. Reapplying the expected corrected definition
is a no-op. No settings, audit records or sessions are edited.

The API accepts both old and new codes as HTTP 409. This is not a global
replacement of real serialization failures.

## Verification

Run:

```
node scripts/run-isolated-tests.mjs --allow-local-postgrest --allow-local-postgres node --test --test-concurrency=1 api/_lib/salesSettingsConflict.postgres.test.mjs api/_lib/salesFoundation.test.mjs
```

The disposable PostgreSQL/native PostgREST test verifies latest feature
preservation, unchanged ACL, repeat migration, unsupported-definition rejection,
valid saves, bounded stale HTTP 409 without writes, competing saves, tenant
separation and input validation. API tests cover authorization and browser
tenant/actor injection. Service-role RPCs trust server-provided tenant authority;
tenant isolation must also remain enforced by the API.

## Live rollout gate

1. Deploy the API compatibility change first; verify the serving revision contains
   PT409 mapping. The agent must not publish automatically.
2. Obtain explicit approval to apply this exact migration to external DEST
   project `lvmzliemqnieeoruhkik`. Do not apply all outstanding migrations.
3. Use the existing destination-verifying connection helper. Read the current
   function and ACL before applying the transaction; compare afterward to ensure
   only the exact exception code changed. Confirm service-role execution remains
   allowed and browser/public execution remains denied.
4. Do not reproduce stale settings mutations on production, terminate backend
   sessions, or edit settings to force a test. Previously executing transactions
   may not adopt the replacement immediately; investigate separately if errors
   continue.
5. Compare fixed UTC windows of Postgres log messages containing the exact
   exception. Baseline: 86,294 errors in 2026-11-16 15:33–2026-11-17 15:33 UTC.
   Record application/deployment timestamps and distinguish 40001 from PT409.
   Initially inspect a completed short post-application window, then compare a
   full day when available. Report actual counts, not presumed resolution.

## Current status

The 16 focused isolated checks passed. On 2026-11-18, Vercel's production
target was verified as READY/PROMOTED at deployment
`dpl_6xbz2MtYGax9WCUoq2Y2E4cGDWR8`, serving commit
`79e11a63ea48ed2292c7f3d5f562df047654d981` with the compatible API mapping.

Following explicit approval, the migration was applied to verified external DEST
and checked at **2026-11-18 11:19:37.934 UTC**. A complete before/after function
comparison confirmed only the exact exception code changed. Owner, ACL,
security-definer status and configuration were identical. Execution remained
denied for `anon` and `authenticated`, and allowed for `service_role`.
No saved settings or audit records were modified by the migration.

Read-only Supabase log aggregates measured the exact conflict message:

| UTC window on 2026-11-18 (start inclusive, end exclusive) | 40001 | PT409 |
| --- | ---: | ---: |
| 11:14:00–11:19:00 | 300 | 0 |
| 11:19:00–11:19:45 (transition) | 37 | 1 |
| 11:19:45–11:20:45 | 0 | 0 |

The last old-code error was at 11:19:36.971 and the single PT409 at
11:19:37.826. The completion acknowledgment above is not the exact commit
instant. Both transition groups referenced the same backend session-start time.
The after-window query ran at 11:21:58 UTC; twelve other Postgres log entries
provided positive ingestion evidence within that interval.

This supports the retry flood stopping immediately (previously 60 errors/minute).
One minute is not proof of sustained resolution, log ingestion has no guaranteed
completeness watermark, and production user saves were not generated to test it.
The valid-save/stale-save HTTP contract was verified in isolated native PostgREST
tests, not by mutating live settings.
