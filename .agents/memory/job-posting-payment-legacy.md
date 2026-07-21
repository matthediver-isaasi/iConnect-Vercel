---
name: Job posting payment legacy pitfalls
description: Non-member job postings — null tenant_id rows, browser-only confirm, and a mass-email trap in the legacy notification filter.
---

# Job posting payment legacy pitfalls

- **Non-member postings are created WITHOUT tenant_id** (`createJobPostingNonMember` never sets it), so any per-tenant logic (Stripe client, admin queue) must resolve the tenant another way. Safe attribution: probe Stripe-enabled tenants and require the PaymentIntent's `metadata.job_posting_id` to name the exact posting; backfill tenant_id on success.
- **Payment confirm is browser-driven** (`confirmJobPostingPayment`); if the browser never calls it the charge succeeds but the posting stays `pending_payment`. Server-side safety net: hourly cron `/api/cron/reconcile-job-posting-payments` + shared helper `api/_lib/jobPostingPaymentReconciliation.js` (compare-and-set claim keeps it idempotent vs the browser path).
- **NEVER reuse the legacy admin-notify filter** from `handleJobPostingPaymentWebhook`: it selects members whose role merely doesn't exclude `admin.job-postings` — that matches ordinary member roles (e.g. "University Member", ~5k members) and mass-emails the whole tenant. **Why:** this fired once during the July 2026 reconciliation repair and sent a few hundred "awaiting approval" emails to regular members before being killed. **How to apply:** notify only roles with `is_admin`/`is_tenant_admin` true (plus the exclusion check) and hard-cap recipients.
- `amount_paid` on stuck rows can be stale/garbage (e.g. 618 vs the real £50 charge); trust the PaymentIntent amount when reconciling since emails quote it.
