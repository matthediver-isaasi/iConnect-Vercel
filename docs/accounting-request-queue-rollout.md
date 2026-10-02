# Accounting request queue staged rollout

## Current state

**Migration is authored, not applied. No live provider writes or database changes were made by this implementation.** Local verification uses only the isolated test runner and disposable Unix-socket PostgreSQL.

The new cron is explicitly OFF unless `ACCOUNTING_REQUEST_QUEUE_ENABLED` equals the literal string `true`. A valid `CRON_SECRET` is still required while disabled; an authorized disabled run returns `enabled: false` without querying the queue or invoking reconciliation. The schedule alone does not activate processing.

## GoCardless source (staged, not enabled)

GoCardless new-request adoption requires **both** `ACCOUNTING_REQUEST_QUEUE_ENABLED=true`
and the exact singular source `gocardless_payment` in the comma-separated
`ACCOUNTING_REQUEST_QUEUE_SOURCES` allowlist. Do not enable production until
`202612050001_accounting_request_queue.sql` and then
`202612050002_accounting_request_gc_preparation.sql` have been separately reviewed
and applied through the approved migration process. Neither migration was applied
by this implementation; no environment settings were changed.

Standard confirmed instalments create their own invoice plus payment; annual
collections use only the exact provider invoice linked to their original history.
The original provider/company, canonical collection, economic context and dedicated
bank setting are durably frozen before provider preparation. Xero bank codes are
resolved to actual account IDs only inside fenced preparation. Retries never use
today's bank setting. Accepted requests retain central ownership even if flags are
later disabled. The accounting-only retry selector includes failed/unpaid and
stale-posting annual obligations; it does not replay historical confirmations,
collect Direct Debits, activate memberships or award benefits.

Missing annual invoices remain failed/waiting without provider calls. A legacy
failed/in-flight writer with uncertain external effects is held for review instead
of assigning it a fresh provider identity. Catch-up arrears retain their existing
allocation owner and cannot be aggregate-posted by this source. BNMS imported
accounting retains its independent invoice-operation/bank/contact authority; its
queue requests are held for review, not released through generic payment posting.

## Activation checklist

1. Review and apply `supabase/migrations/202612050001_accounting_request_queue.sql` separately through the approved destination migration process. It is replay-safe and does not backfill or reconstruct requests.
2. Keep the cron flag OFF while deploying. Check authenticated `GET /api/health/accounting-requests` with `Authorization: Bearer <CRON_SECRET>`. This reads aggregate SQL counts only, never providers; missing migration returns 503. Do not publish the secret in monitoring URLs.
3. Verify service-only RPC grants, immutable saved payloads and binding identity. Service role can read queue tables but cannot mutate them directly. Provider-specific economics, tax and source provenance remain the responsibility of preparation and existing source safeguards; SQL structural validation is not a substitute.
4. Prove each adopted source has a genuine idempotent link handler, verified affected-row checks, saved provider envelopes and the original payment authority. Completed financial results must survive linkage failure. Pending requests must not be returned as completed facade invoices.
5. Ensure exactly one writer owns each operation. Do not run the central writer and legacy event/form/BNMS recovery against the same operation. Preserve existing specialized guards; no historical broad backfill is authorized here.
6. Provider factory must receive core `beforeRequest` composed with source authority checks before every provider/token-refresh/pagination call. Confirm provider switching, company changes, timeout, late responses, 429 and failed completion persistence all fail closed.
7. Adopt a narrow verified producer scope first, then enable the cron flag only after that scope's integration is proven. Any producer-specific activation controls also require explicit review; enabling the cron does not by itself authorize all producers.

Commercial sales require both `ACCOUNTING_REQUEST_QUEUE_ENABLED=true` and
`sales_commercial_sale` in the comma-separated `ACCOUNTING_REQUEST_QUEUE_SOURCES`
allowlist for NEW queue requests. The product allowlist currently supports only
commercial sales (Xero and QuickBooks), not training-fund or generic legacy
invoice creation. Existing accepted sale owners are looked up and resumed even
with either flag OFF; no legacy fallback is permitted for an accepted owner or
a failed ownership lookup. OFF installations tolerate only an absent queue table
before migration; fresh sources without queue ownership retain the legacy path.

## Monitoring and rollback

Manual unpaid membership adoption requires the same enable flag plus
`member_membership_history` or `organisation_membership_history` in the source
allowlist. Other paid/form/card-instalment/add-on membership paths retain their
existing owners. Manual membership contact/tax preparation still happens before
its durable prepared request; the GoCardless source described above instead
persists preparation evidence and recovers preparation rate limits. Renewals,
workflows, training-fund purchases, existing event recovery and the independent
BNMS/arrears owners have not been transferred wholesale. This stage must not be
described as universal accounting recovery.

Health reports counts for pending/retry/running/unknown/review/complete, overdue work, expired leases and provider cooldown waiting. Unknown writes and review cases yield attention/503; a valid cooldown alone yields waiting_provider. It is not a cron heartbeat: an empty healthy queue does not prove a successful sweep.

Set `ACCOUNTING_REQUEST_QUEUE_ENABLED` back to false to stop new cron claims; already executing requests can finish. Disable the corresponding producer adoption gate as well, without routing existing queued operations to a second writer. Never delete/reset saved authority, unknown writes, provider IDs or payment results. An unknown write requires uniquely matched read-only discovery or manual review, not a blind retry. Investigate review rows under service authorization without exposing saved customer payloads in public logs.

## Verification

Run only through the isolated runner:

`node scripts/run-isolated-tests.mjs --allow-local-postgres node --test api/_lib/accountingRequestQueue.test.mjs api/_lib/accountingRequestQueue.postgres.test.mjs api/_lib/accountingRequestQueueEndpoints.test.mjs`

These checks do not prove live credentials, real provider behavior, deployed scheduler execution or product-source adoption. Those require separately authorized rollout verification.