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

Implementation and isolated tests are ready. Live application, deployment
verification and post-rollout measurement require the rollout gate above.
