# Job posting alerts

## Rollout

`supabase/migrations/20261204_job_posting_alerts.sql` must be applied to the
approved application database **before** deploying this change. It was tested
in isolated PostgreSQL before the approved live application below.
Applied to live DEST (`lvmzliemqnieeoruhkik`) on 25 October 2026.
SHA-256: `9bc406ec988e276b53a10a10ce18628683b0e1e1c3b0b8c30df5ac3851c2d96b`.
RLS and service-only table/RPC privileges were checked before commit, and the
REST schema cache was verified afterward. No tenant settings, subscriptions or
delivery queue rows were created. 297 existing published/historical jobs were
marked to prevent retroactive notifications. SOURCE was not changed.

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
