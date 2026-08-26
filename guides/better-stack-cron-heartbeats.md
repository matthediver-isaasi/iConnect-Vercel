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
| 9 | Form-payment reconciliation | `/api/cron/reconcile-form-payments` | `40 * * * *` | Hourly at :40 | 90 minutes | `BETTERSTACK_HEARTBEAT_FORM_PAYMENT_RECONCILIATION_URL` |
| 10 | Automatic membership processing | `/api/cron/process-automatic-memberships` | `* * * * *` | Every minute | 10 minutes | `BETTERSTACK_HEARTBEAT_AUTOMATIC_MEMBERSHIP_PROCESSING_URL` |

Backup continuation, a completed-for-today invocation, and a lock-held
invocation are healthy outcomes. The backup monitors should therefore expect
the final successful ping from the active window rather than requiring a
backup to start from scratch on every invocation. A runner failure or a
meaningful partial backup error sends the `/fail` heartbeat.

## Complete production cron inventory

The table below is the complete 30-schedule inventory in `vercel.json`.
“Covered” means that schedule has its own heartbeat from the ten-monitor
registry. The other twenty continue to run normally but are not individually
monitored under the current plan.

| # | Endpoint | Schedule (UTC) | Coverage |
|---:|---|---|---|
| 1 | `/api/cron/send-event-reminders` | `* * * * *` | Not individually monitored |
| 2 | `/api/cron/process-membership-renewals` | `0 * * * *` | **Covered — membership renewals** |
| 3 | `/api/email-campaigns/process-scheduled` | `* * * * *` | **Covered — scheduled campaigns** |
| 4 | `/api/cron/sync-outlook-emails` | `*/5 * * * *` | Not individually monitored |
| 5 | `/api/cron/zoho-crm-reconcile` | `*/15 * * * *` | Not individually monitored |
| 6 | `/api/cron/zoho-crm-reconcile-outbound` | `*/5 * * * *` | Not individually monitored |
| 7 | `/api/cron/sync-mailgun-campaign-events` | `0 */6 * * *` | Not individually monitored |
| 8 | `/api/cron/reconcile-membership-invoice-payments` | `0 */3 * * *` | **Covered — membership invoice-payment reconciliation** |
| 9 | `/api/cron/reconcile-training-fund-purchases` | `0 */3 * * *` | Not individually monitored |
| 10 | `/api/cron/reconcile-job-posting-payments` | `30 * * * *` | Not individually monitored |
| 11 | `/api/cron/sync-adzuna-job-feeds` | `10 * * * *` | Not individually monitored |
| 12 | `/api/cron/reconcile-form-payments` | `40 * * * *` | **Covered — form-payment reconciliation** |
| 13 | `/api/cron/run-form-submission-export-jobs` | `* * * * *` | Not individually monitored |
| 14 | `/api/cron/run-import-jobs` | `* * * * *` | Not individually monitored |
| 15 | `/api/cron/recompute-tenant-storage` | `0 3 * * *` | Not individually monitored |
| 16 | `/api/cron/send-group-event-reminders` | `*/30 * * * *` | Not individually monitored |
| 17 | `/api/cron/send-po-reminders` | `0 8 * * *` | Not individually monitored |
| 18 | `/api/cron/run-scheduled-workflows` | `0 * * * *` | **Covered — scheduled workflows** |
| 19 | `/api/cron/reindex-member-content` | `0 */6 * * *` | Not individually monitored |
| 20 | `/api/cron/reindex-help-articles` | `0 3 * * *` | Not individually monitored |
| 21 | `/api/cron/backup-storage-to-r2` | `*/10 2-7 * * *` | **Covered — storage backup** |
| 22 | `/api/cron/backup-database-to-r2` | `5-59/10 2-7 * * *` | **Covered — database backup** |
| 23 | `/api/cron/process-voucher-expiries` | `30 1 * * *` | Not individually monitored |
| 24 | `/api/cron/support-auto-close` | `0 4 * * *` | Not individually monitored |
| 25 | `/api/cron/close-voucher-month` | `15 2 1-3 * *` | Not individually monitored |
| 26 | `/api/cron/reconcile-gocardless` | `15 */6 * * *` | **Covered — GoCardless reconciliation** |
| 27 | `/api/cron/gocardless-arrears` | `45 */6 * * *` | Not individually monitored |
| 28 | `/api/cron/reconcile-stripe-card-plans` | `25 */6 * * *` | **Covered — Stripe card-plan reconciliation** |
| 29 | `/api/cron/grant-speaker-awards` | `*/10 * * * *` | Not individually monitored |
| 30 | `/api/cron/process-automatic-memberships` | `* * * * *` | **Covered — automatic membership processing** |

If monitor capacity increases, the next candidates should be selected based
on current operational impact and incident history. Good candidates to review
first are event reminders, form-submission exports, imports, training-fund
payment reconciliation, and GoCardless arrears. Adding them should use a
distinct variable and monitor per schedule rather than a shared heartbeat.