# Job posting alerts

## Rollout

Apply `supabase/migrations/20261204_job_posting_alerts.sql` to the approved
application database **before** deploying this change. This migration has been
tested in isolated PostgreSQL; it has not yet been applied to live DEST.
It adds service-only subscription-prompt/settings/publication/delivery tables,
a protected system category marker, queue functions and publication triggers.
No tenant is enabled and no member is subscribed by migration.

Deploy API and client changes together, including the once-per-minute
`/api/cron/send-job-alerts` cron. It requires the existing `CRON_SECRET`, fails
closed if absent, and has a 60-second invocation budget.

Tenant administrators then enable Job postings subscriptions in `/admin/settings`.
This atomically creates (or reactivates) the protected member-only category.
Disabling preserves consent/history but skips pending alerts; reenabling does
not backfill jobs published while disabled.

## Behavior

- Both direct and Adzuna vacancies trigger once when first made active.
- Existing active/closed/expired jobs are marked as historical at migration.
- Drafts and pending-approval jobs only trigger on publication.
- Each member receives email plus an inbox copy after successful delivery.
- The email links through `/JobDetails?id=…&jobAlert=1`; guests sign in and
  return to that same job.
- Job Board and About-me use the canonical category preference. Global opt-outs,
  Job Board access, member pause/access status, hard bounces, current job status
  and tenant enablement are rechecked before delivery.
- Ask later snoozes for seven days. Don't ask again only suppresses the prompt;
  the visible subscription switch remains available.

## Delivery evidence

`job_alert_delivery` records each job/member attempt with an exclusive lease.
Rate limits and known temporary failures do not consume the genuine retry
budget. Failed eligibility checks retry without sending. Five genuine provider
rejections mark a delivery failed.

Provider acceptance and the inbox message are finalized atomically through
`finish_job_alert_delivery`; repeating finalization does not duplicate inbox
messages. An interrupted provider request or an expired `sending` lease becomes
`uncertain`, never automatically resent. Reconcile Mailgun evidence before
authorizing another submission. These are operational records, not fabricated
delivery confirmations. No live email was sent during implementation tests.
