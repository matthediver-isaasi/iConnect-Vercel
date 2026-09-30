# Better Stack cron heartbeats

This guide configures the ten Better Stack heartbeat monitors available on the
current production plan. Each selected cron has its own heartbeat URL. Do not
reuse one URL for multiple jobs: a shared URL can say that *something* ran but
cannot identify which schedule stopped.

The application sends a normal GET to the configured URL after an authorised
invocation finishes. For a failed invocation it appends `/fail` to the URL
path itself. Store only the normal Better Stack heartbeat URL in Vercel; do
not create or store a second failure URL.

## Production setup

1. In Better Stack, create one heartbeat monitor for each covered schedule
   below. Copy each monitor's generated heartbeat URL.
2. Add the matching variable to the **Production** environment in the Vercel
   project. The variables are optional and independent; an unset variable
   disables only that monitor.
3. Keep each monitor's expected cadence and grace period aligned with the
   matrix. Configure the backup monitors with an active window of
   **02:00–07:59 UTC** (or pause the monitor outside that window), because
   those jobs intentionally do not run overnight.
4. Deploy the production environment after changing variables. A successful
   authorised cron run will then ping the monitor. An unauthorised request
   never sends a heartbeat.

Heartbeat delivery is best effort. URL timeouts and non-2xx responses are
logged and swallowed, so Better Stack cannot change the cron job's response,
retry policy, schedule, or business result.

## Ten-monitor setup matrix

The expected cadences and grace periods below are monitor setup recommendations,
not proof of deployed Better Stack settings or observed cron execution. Schedules
reflect the repository's `vercel.json`. If an existing form-payment reconciliation
monitor still uses the old cadence, align it separately with the every-minute
cadence and suggested 10-minute grace period; this documentation change does not
update any live monitor.

| # | Better Stack monitor | Cron endpoint | Vercel schedule (UTC) | Expected cadence | Suggested grace | Production variable |
|---:|---|---|---|---|---|---|
| 1 | Membership renewals | `/api/cron/process-membership-renewals` | `0 * * * *` | Hourly | 90 minutes | `BETTERSTACK_HEARTBEAT_MEMBERSHIP_RENEWALS_URL` |
| 2 | Membership invoice-payment reconciliation | `/api/cron/reconcile-membership-invoice-payments` | `0 */3 * * *` | Every 3 hours | 4 hours | `BETTERSTACK_HEARTBEAT_MEMBERSHIP_PAYMENT_RECONCILIATION_URL` |
| 3 | GoCardless reconciliation | `/api/cron/reconcile-gocardless` | `15 */6 * * *` | Every 6 hours | 8 hours | `BETTERSTACK_HEARTBEAT_GOCARDLESS_RECONCILIATION_URL` |
| 4 | Stripe card-plan reconciliation | `/api/cron/reconcile-stripe-card-plans` | `25 */6 * * *` | Every 6 hours | 8 hours | `BETTERSTACK_HEARTBEAT_STRIPE_CARD_PLAN_RECONCILIATION_URL` |
| 5 | Scheduled workflows | `/api/cron/run-scheduled-workflows` | `0 * * * *` | Hourly | 90 minutes | `BETTERSTACK_HEARTBEAT_SCHEDULED_WORKFLOWS_URL` |
| 6 | Scheduled campaigns | `/api/email-campaigns/process-scheduled` | `* * * * *` | Every minute | 10 minutes | `BETTERSTACK_HEARTBEAT_SCHEDULED_CAMPAIGNS_URL` |
| 7 | Database backup to R2 | `/api/cron/backup-database-to-r2` | `5-59/10 2-7 * * *` | Every 10 minutes, 02:05–07:55 UTC | 20 minutes while active | `BETTERSTACK_HEARTBEAT_DATABASE_BACKUP_URL` |
| 8 | Storage backup to R2 | `/api/cron/backup-storage-to-r2` | `*/10 2-7 * * *` | Every 10 minutes, 02:00–07:50 UTC | 20 minutes while active | `BETTERSTACK_HEARTBEAT_STORAGE_BACKUP_URL` |
| 9 | Form-payment reconciliation | `/api/cron/reconcile-form-payments` | `* * * * *` | Every minute | 10 minutes | `BETTERSTACK_HEARTBEAT_FORM_PAYMENT_RECONCILIATION_URL` |
| 10 | Automatic membership processing | `/api/cron/process-automatic-memberships` | `* * * * *` | Every minute | 10 minutes | `BETTERSTACK_HEARTBEAT_AUTOMATIC_MEMBERSHIP_PROCESSING_URL` |

Backup continuation, a completed-for-today invocation, and a lock-held
invocation are healthy outcomes. The backup monitors should therefore expect
the final successful ping from the active window rather than requiring a
backup to start from scratch on every invocation. A runner failure or a
meaningful partial backup error sends the `/fail` heartbeat.

### Membership-renewal continuation outcomes

The membership-renewal worker uses a durable global lease and bounded
continuation. Its outcome mapping differs deliberately from backup lock
semantics:

| Renewal outcome | Heartbeat behaviour | Reason |
|---|---|---|
| `completed` | Normal success URL | All selected work completed without errors. |
| `deferred` | Normal success URL | Safe progress was checkpointed and remaining work is expected to resume later. |
| `failed` | `/fail` URL | Attempted work, state persistence, finalisation, or another real operation failed. |
| `stalled` | `/fail` URL | Pause, billing, or expiry hit three consecutive budget deferrals without the progress required for that stage. |
| `busy` | No heartbeat from the competing invocation | It does not own the work and cannot prove that the lease owner is healthy. |

Structured renewal logs contain `job`, `owner`, `stage`, `event`,
`elapsed_ms`, and stage `duration_ms`, with expiry progress including tenant,
cursor, examined, and enforced counts. The corresponding
`scheduled_task_log.details` records the truthful outcome, billing stage, and
progress. A `deferred` result is therefore observable pending work, not a
silent success; `failed` and `stalled` must never be relabelled as deferral.

Tenant discovery is itself resumable: it runs for up to three seconds, saves
`discoveryOffset`, and reuses a cached tenant registry so known tenants continue
to receive work while a large directory is still being paged. Expiry database
reads use a two-second actual abort-and-await deadline, capped by remaining
slice time. A cooperative boundary before starting more work is a healthy
partial `deferred` result; an aborted/failed read is a true unhealthy error.

No-progress detection covers all bounded work: three consecutive pause
deferrals without cursor movement, billing deferrals without stage/cursor
movement, or incomplete expiry slices with no examined/enforced rows produce
`stalled`.

The runner's 48-second work boundary leaves finalisation time under Vercel's
60-second ceiling. Completion logs are inserted in batches of 200; no new batch
starts after 54 seconds, and unwritten logs make the result unhealthy. The
global lease lasts 120 seconds and is not renewed, so a second invocation can
be `busy` even after the owner has returned. Keep the suggested 90-minute
monitor grace: the next hourly owner run can provide the next conclusive
heartbeat.

The time boundaries are cooperative for provider rows, not a hard end-to-end
guarantee. A started Stripe request has an 80-second default timeout and two
network retries; GoCardless has a 15-second per-request timeout that does not
include response-body parsing; Mailgun has a 15-second socket/response timeout.
A row already in progress can therefore overrun the renewal stage boundary.
The runner never reports such work as cancelled merely because its local
budget elapsed.

**Deployment note:** the continuation and expiry-journal migrations must be
approved and applied before deploying the bounded handler. They have not been
applied to production merely by adding the application code or this guide.

After an approved release, verify using naturally scheduled hourly runs rather
than manually triggering live renewal effects:

1. Confirm the endpoint has no HTTP 504 in Vercel's scheduled request records.
2. Confirm structured stage timing and expiry progress advance in application
   logs, including advancing `nextOffset` when discovery defers.
3. Read `scheduled_task_log` and confirm the billing stage plus
   `completed`/`deferred`/`failed`/`stalled` outcome.
4. Confirm the corresponding success or failure delivery in Better Stack.
5. Treat a `busy` invocation as inconclusive and correlate it with the owner
   UUID; do not expect a second heartbeat from the competitor.
6. Treat expiry read aborts and missing completion-log batches as failures, not
   expected partial-budget deferrals.

Read-only database verification:

```sql
SELECT executed_at, tenant_id, status,
       details::jsonb->>'outcome' AS outcome,
       details::jsonb->>'duration_ms' AS duration_ms,
       details::jsonb->'billing' AS billing,
       details::jsonb->'progress' AS progress
FROM public.scheduled_task_log
WHERE task_name = 'membership_renewals'
ORDER BY executed_at DESC
LIMIT 100;

SELECT owner, lease_until, updated_at, state
FROM public.membership_renewal_cron_state
WHERE singleton = true;
```

These queries do not prove heartbeat delivery; verify delivery in Better Stack.
See `guides/membership-renewals-continuation.md` for deployment order,
safeguards, and the complete verification runbook.

## Complete production cron inventory

The table below is the complete 34-schedule inventory in `vercel.json`.
“Covered” means that schedule has its own heartbeat from the ten-monitor
registry. The other twenty-four continue to run normally but are not individually
monitored under the current plan.

| # | Endpoint | Schedule (UTC) | Coverage |
|---:|---|---|---|
| 1 | `/api/cron/refresh-dashboard-widgets` | `* * * * *` | Not individually monitored — see `guides/dashboard-widget-cache.md` for backlog diagnostics |
| 2 | `/api/cron/send-event-reminders` | `* * * * *` | Not individually monitored |
| 3 | `/api/cron/process-membership-renewals` | `0 * * * *` | **Covered — membership renewals** |
| 4 | `/api/email-campaigns/process-scheduled` | `* * * * *` | **Covered — scheduled campaigns** |
| 5 | `/api/cron/sync-outlook-emails` | `*/5 * * * *` | Not individually monitored |
| 6 | `/api/teams/attendance-auto-sync` | `*/10 * * * *` | Not individually monitored |
| 7 | `/api/cron/zoho-crm-reconcile` | `*/15 * * * *` | Not individually monitored |
| 8 | `/api/cron/zoho-crm-reconcile-outbound` | `*/5 * * * *` | Not individually monitored |
| 9 | `/api/cron/sync-mailgun-campaign-events` | `0 */6 * * *` | Not individually monitored |
| 10 | `/api/cron/reconcile-membership-invoice-payments` | `0 */3 * * *` | **Covered — membership invoice-payment reconciliation** |
| 11 | `/api/cron/reconcile-training-fund-purchases` | `0 */3 * * *` | Not individually monitored |
| 12 | `/api/cron/reconcile-job-posting-payments` | `30 * * * *` | Not individually monitored |
| 13 | `/api/cron/sync-adzuna-job-feeds` | `10 * * * *` | Not individually monitored |
| 14 | `/api/cron/reconcile-form-payments` | `* * * * *` | **Covered — form-payment reconciliation** |
| 15 | `/api/cron/run-form-submission-export-jobs` | `* * * * *` | Not individually monitored |
| 16 | `/api/cron/run-import-jobs` | `* * * * *` | Not individually monitored |
| 17 | `/api/cron/recompute-tenant-storage` | `0 3 * * *` | Not individually monitored |
| 18 | `/api/cron/send-group-event-reminders` | `*/30 * * * *` | Not individually monitored |
| 19 | `/api/cron/send-po-reminders` | `0 8 * * *` | Not individually monitored |
| 20 | `/api/cron/run-scheduled-workflows` | `0 * * * *` | **Covered — scheduled workflows** |
| 21 | `/api/cron/reindex-member-content` | `0 */6 * * *` | Not individually monitored |
| 22 | `/api/cron/reindex-help-articles` | `0 3 * * *` | Not individually monitored |
| 23 | `/api/cron/backup-storage-to-r2` | `*/10 2-7 * * *` | **Covered — storage backup** |
| 24 | `/api/cron/backup-database-to-r2` | `5-59/10 2-7 * * *` | **Covered — database backup** |
| 25 | `/api/cron/process-voucher-expiries` | `30 1 * * *` | Not individually monitored |
| 26 | `/api/cron/support-auto-close` | `0 4 * * *` | Not individually monitored |
| 27 | `/api/cron/close-voucher-month` | `15 2 1-3 * *` | Not individually monitored |
| 28 | `/api/cron/reconcile-gocardless` | `15 */6 * * *` | **Covered — GoCardless reconciliation** |
| 29 | `/api/cron/gocardless-arrears` | `45 */6 * * *` | Not individually monitored |
| 30 | `/api/cron/gocardless-auto-retries` | `*/15 * * * *` | Not individually monitored |
| 31 | `/api/cron/reconcile-stripe-card-plans` | `25 */6 * * *` | **Covered — Stripe card-plan reconciliation** |
| 32 | `/api/cron/grant-speaker-awards` | `*/10 * * * *` | Not individually monitored |
| 33 | `/api/cron/process-automatic-memberships` | `* * * * *` | **Covered — automatic membership processing** |
| 34 | `/api/cron/process-attendance-transitions` | `* * * * *` | Not individually monitored |

If monitor capacity increases, the next candidates should be selected based
on current operational impact and incident history. Good candidates to review
first are event reminders, form-submission exports, imports, training-fund
payment reconciliation, and GoCardless arrears. Adding them should use a
distinct variable and monitor per schedule rather than a shared heartbeat.