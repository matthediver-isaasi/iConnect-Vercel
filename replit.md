# Membership Management Platform
A multi-tenant SaaS platform unifying member, event, booking, resource, and blog post management for organizations.

## Run & Operate
-   **Run Dev Server:** `npm run dev`
-   **Build:** `npm run build`
-   **Typecheck:** `npm run typecheck`
-   **Codegen:** `npm run codegen`
-   **DB Push:** `npx drizzle-kit push:pg` (or `npm run db:push`) — only works from environments with IPv6 outbound; **not from this Replit workspace** (see "Database connection").
-   **Migrations:** every `.sql` in `supabase/migrations/` is idempotent and applied against `DEST_DATABASE_URL` (pooler). Most migrations have a matching `node scripts/apply-*.mjs` runner; check `scripts/` before applying anything by hand.
-   **Storage usage baseline / reconcile:** `node scripts/recompute-tenant-storage.mjs [--dry-run] [--tenant=<uuid>]`. Run after the storage-usage migration, after any drift incident, or trust the nightly cron at `/api/cron/recompute-tenant-storage` (03:00 UTC, `CRON_SECRET`-guarded).
-   **Membership payment status backfill (one-off, BEFORE enabling reconciliation cron):** `node scripts/backfill-membership-payment-status.mjs [--dry-run] [--tenant=<uuid>] [--table=…] [--limit=N]`. Silently flips paid/voided rows without firing workflows. Idempotent.
-   **Tenant membership backfill (one-off, idempotent):** `node scripts/backfill-tenant-membership.mjs [--tenant=<uuid>] [--limit=N] [--verbose] [--apply]`. Defaults to dry-run. Insert-only — adds missing `tenant_membership` link rows for members that already have `identity_id` + `tenant_id`. Skips soft-deleted, duplicates, and any candidate where `resolveMemberForTenantLogin` would resolve a different member row (auth-parity check). Removes the orange "No tenant membership" badge.
-   **Seed DD-by-status pie widgets (gsf only, idempotent):** `node scripts/seed-dd-status-widgets.mjs`. Hard-pinned to tenant `21296ad6-1350-483a-a90c-1b06ece70501`; refuses other `TENANT_ID`s.
-   **Seed GSF live-ESO/SO membership widgets (gsf only, idempotent):** `node scripts/seed-gsf-membership-widgets.mjs`. Hard-pinned to tenant `21296ad6-1350-483a-a90c-1b06ece70501`; seeds 3 shared dashboard widgets (current students sum, trading_as pie, cumulative students sum) filtered to `org_status='Active'` AND `org_type IN ('ESO','SO')`.
-   **Enable guest access on GSF Active orgs (gsf only, one-off, idempotent):** `node scripts/enable-guest-access-active-gsf-orgs.mjs [--apply] [--verbose]`. Hard-pinned to tenant `21296ad6-1350-483a-a90c-1b06ece70501`; sets `guest_access_enabled=true`, `guest_access_period_days=NULL`, `guest_access_unlimited=false` on every org with `org_status='Active'` so the tenant default (7 days) governs. Dry-run by default.

## Env vars (current canonical set)
Resolve secrets defensively in scripts — some legacy ones use `DEV_*` / `SUPABASE_*` names; prefer the `DEST_*` names below for new code.

| Var | Purpose |
| --- | ------- |
| `DEST_SUPABASE_URL` / `DEST_SUPABASE_KEY` / `DEST_DATABASE_URL` | Destination (prod) Supabase. See "Database connection". |
| `SOURCE_SUPABASE_URL` / `SOURCE_SUPABASE_KEY` / `SOURCE_DATABASE_URL` | Legacy single-tenant snapshot — only used by migration scripts. |
| `DATABASE_URL` | Direct host (IPv6 only) — used by Vercel / Drizzle push, not this workspace. |
| `MAILGUN_API_KEY`, `MAILGUN_REGION` (default `eu`), `MAILGUN_FROM_EMAIL`, `APP_DOMAIN` (default `iconn.app`) | Email sending. `MAILGUN_FROM_EMAIL` is the non-system default From; system emails are pinned to `noreply@mail.${APP_DOMAIN}` regardless. |
| `STRIPE_SECRET_KEY` | Tenant Stripe AND platform-side paid-plan upgrade Checkout. |
| `STRIPE_PLAN_WEBHOOK_SECRET` | Verifies `/api/webhooks/stripe-plan` from the platform Stripe account. Configure dashboard to deliver `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`. |
| `XERO_CLIENT_ID` | Xero OAuth. |
| `QUICKBOOKS_REDIRECT_URI` (optional) | Overrides default `${origin}/api/quickbooks/callback` for stable QBO OAuth redirect. |
| `BROWSERLESS_API_TOKEN`, `BROWSERLESS_BASE_URL` (opt), `BROWSERLESS_AUDIT_TIMEOUT_MS` (opt) | Accessibility audits via browserless.io. |
| `VITE_APP_URL` | Frontend-known app URL. |
| `CAPTCHA_PROVIDER`, `CAPTCHA_SECRET_KEY` (opt) | Self-serve signup captcha (hCaptcha/Turnstile/reCAPTCHA). Bypassed when not production. |
| `SIGNUP_RATE_IP_PER_HOUR`, `SIGNUP_RATE_EMAIL_PER_DAY` (opt) | Self-serve signup rate limits. |
| `CRON_SECRET` | Guards all `/api/cron/*` endpoints. |
| `ENABLE_RESET_DEBUG` (opt, `'true'`) | Temporary diagnostic: `/api/auth/request-admin-password-reset` returns a `debug` field (`no_identity`/`no_owner_membership`/`email_failed`/`sent`). Leave unset in normal operation so account existence is not disclosed. |

## Database connection (read this before any DB work from this workspace)
There are two Supabase projects this codebase talks to:

| Role | What it is | URL secret | Postgres URL secret | Service-role key secret |
| ---- | ---------- | ---------- | ------------------- | ----------------------- |
| **Destination (current prod)** | Multi-tenant iConnect DB | `DEST_SUPABASE_URL` (`https://lvmzliemqnieeoruhkik.supabase.co`) | `DEST_DATABASE_URL` | `DEST_SUPABASE_KEY` |
| **Source (legacy)** | Pre-multi-tenancy single-tenant snapshot, used by migration scripts | `SOURCE_SUPABASE_URL` | `SOURCE_DATABASE_URL` | `SOURCE_SUPABASE_KEY` |

**The Supabase direct host (`db.<project>.supabase.co`) is unreachable from this Replit workspace** — it publishes only IPv6 (AAAA) DNS and the Replit container has no IPv6 outbound route, so `psql`, `execute_sql_tool`, `drizzle-kit push`, and any raw `pg`/Drizzle client pointed at the direct host fail with `ENOTFOUND` / `ENETUNREACH`. Those tools work from Vercel functions, the user's laptop, and CI — just not from here against the direct host.

**The Supabase Pooler hostname IS IPv4-reachable from this workspace** (`aws-1-eu-central-1.pooler.supabase.com:5432`, which is what `DEST_DATABASE_URL` already points to). `pg` clients using `DEST_DATABASE_URL` (transaction-pooler mode) work from Replit for read/write queries and DDL such as `CREATE INDEX`. Prefer `@supabase/supabase-js` for ordinary CRUD (REST endpoint is also IPv4-reachable, more ergonomic); reach for `pg` via `DEST_DATABASE_URL` only when you need raw SQL / DDL the REST API can't do.

For any DB access from this workspace (scripts, ad-hoc debugging, one-off data fixes), use **`@supabase/supabase-js`** with the service-role key. Working reference: `scripts/debug-tenant.mjs`.

```js
import { createClient } from '@supabase/supabase-js';
const supabase = createClient(
  process.env.DEST_SUPABASE_URL,
  process.env.DEST_SUPABASE_KEY
);
```

Quick one-off from bash (env vars ARE available in the shell):

```bash
node -e "
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(process.env.DEST_SUPABASE_URL, process.env.DEST_SUPABASE_KEY, { auth: { persistSession: false } });
(async () => {
  const { data, error } = await sb.from('tenant').select('id, slug, name').limit(5);
  console.log({ data, error });
})();
"
```

## Stack
-   **Frontend:** React 18 (TypeScript/JSX), Vite, TanStack Query, shadcn/ui (Radix UI), Tailwind CSS
-   **Backend:** Express.js, PostgreSQL, Drizzle ORM
-   **Deployment:** Vercel (serverless functions)
-   **Runtime:** Node.js (Vercel)

## Where things live
-   `/client`: Frontend source code (`client/src/design-system` = custom "new-york" shadcn variant)
-   `/api`: Backend API endpoints (Vercel serverless functions); shared helpers under `api/_lib/`
-   `/supabase/migrations`: Database migrations (idempotent SQL)
-   `/scripts`: Utility and migration scripts
-   `client/index.html` + `api/render.js`: SSR for SEO/OG tag injection
-   `supabase/schema.prisma`: Database schema (source of truth for Drizzle)

## Architecture decisions
-   **Multi-tenancy:** Data isolation at GLOBAL / TENANT / ORGANIZATION / MEMBER levels via `tenant_id` and `organization_id`. The shared entity API hard-fails any TENANT- or ORGANIZATION-scoped request without a usable tenant context.
-   **Identity:** Unified identity with per-tenant password isolation, Google OAuth, feature-based role management.
-   **Email sending:** `api/_lib/emailService.js` resolves the sending domain off `tenantId` for tenant→member emails. **System emails** (platform→tenant-owner: admin reset, signup verification, team invite, billing notifications) MUST pass `systemEmail: true` (or use `sendSystemEmail()`); this forces both Mailgun domain AND From identity to `mail.${APP_DOMAIN}` / `noreply@mail.${APP_DOMAIN}` regardless of `MAILGUN_FROM_EMAIL` or any caller-provided `from`. System reset/verification links must point at `${APP_DOMAIN}/...` not a tenant subdomain.
-   **Dynamic SEO:** SSR meta-tag injection per-tenant via `api/render.js`. Per-page metadata resolved by `api/_lib/entityMeta.js` (per-entity detail pages, IEditPage CMS pages, and section/list routes). Per-entity `seo_title` / `seo_description` / `og_image_url` overrides on events, complex events, blog posts, news, fundraising campaigns, resources, and dynamic directories; UI for these lives in `client/src/components/blog/SEOSettings.jsx`. `og:image` URLs on `vault.iconn.app` or `*.supabase.co` are proxied through `/api/og-image` to avoid bot blocking.
-   **Event deletion:** Multi-step cancellation flow (refunds, reinstatements, Zoom unregistration) before any data purge. Direct deletion of events is deprecated for UI flows.
-   **Semantic `warning` color:** `--warning` / `--warning-foreground` CSS vars in `client/src/index.css` (both `:root` and `.dark`, WCAG-AA in both). Use `text-warning`, `bg-warning`, `<Badge variant="warning">`, `<Alert variant="warning">` instead of raw `text-amber-*` / `text-yellow-*` / `text-orange-*` palette classes.
-   **Membership invoice accounting-sync failure (Task #1112):** When the post-payment Stripe-→-history insert succeeds but the subsequent QBO/Xero invoice mint fails, the history row is flagged `accounting_sync_status='failed'` + `accounting_sync_error='<provider error>'` (NOT silently swallowed). Admin UI shows a "Invoice failed" warning badge + Retry button in the Membership Fee History card (`OrgMembershipTab.jsx`). Retry endpoint: `POST /api/admin/membership-invoice-retry` (tenant-admin RBAC; rejects rows that already have an `accounting_invoice_id`). The fee-token confirm_payment flow (`api/public/membership-fees/[token].js`) now only flips token status to `paid` AFTER the history row is safely inserted; on `simResult.success=false` it auto-refunds the Stripe payment and returns 500. Stuck-paid tokens (paid + no history row) return 409 instead of silently re-running. Recovery: `node scripts/backfill-stuck-membership-fee-tokens.mjs --action=complete|refund --apply` (hardcoded to known-stuck token ids; supports `--token=<uuid>` override; dry-run by default).
-   **Membership invoice payment reconciliation:** `organisation_membership_history` and `member_membership_history` carry `payment_status` (`unpaid`/`paid`/`partial`/`voided`) + `paid_at`, separate from the lifecycle `status` column. Cron `/api/cron/reconcile-membership-invoice-payments` (every 3h, `CRON_SECRET`-guarded) asks each row's accounting provider (Xero or QBO) for current invoice status and fires workflows on `unpaid -> paid` transitions only. Inline reconciliation also runs from the Stripe portal-payment path and from a per-row "Check now" admin button. See `api/_lib/membershipPaymentReconciliation.js`, `api/_lib/accountingProvider.js`, `OrgMembershipTab.jsx`, `api/admin/membership-payment-reconcile.js`.
-   **Tenant storage metering:** `tenant.storage_used_bytes` (BIGINT) drives `checkStorageQuota` in `api/_lib/planQuota.js` and the storage row on `/admin/plan-usage`. Maintained incrementally by upload endpoints via `addTenantStorageBytes(tenantId, delta)` in `api/_lib/tenantStorageUsage.js` (atomic Postgres RPC, clamped at 0). Deletes decrement when the original size is known. Signed-URL endpoints attribute the *claimed* size at issue time, so the counter can drift; re-baseline with `scripts/recompute-tenant-storage.mjs` or trust the nightly cron.
-   **Paid-plan upgrade flow (`/admin/plan-usage` → Stripe Checkout):** `PlanUsage.jsx` → `api/admin/plan-checkout.js` (tenant-admin RBAC, uses PLATFORM `STRIPE_SECRET_KEY`, NOT tenant's connected Stripe). Two branches: first-time creates a Checkout Session; existing live sub (`active`/`trialing`/`past_due`) calls `stripe.subscriptions.update` to swap price in place with proration — never creates a parallel sub. Webhook `api/webhooks/stripe-plan.js` (bodyParser disabled, `STRIPE_PLAN_WEBHOOK_SECRET`) upserts `tenant_subscription` and only flips `tenant.plan_code` once subscription status is `active`/`trialing`; `customer.subscription.deleted` reverts to `free`.
-   **Self-serve tenant signup & onboarding (`/signup` → wizard):** `api/public/signup-start.js` (captcha + rate limits + pending `tenant_signup` row + verification email) → `api/public/signup-verify.js` (calls `provisionTenant` with `planCode='free'`, `onboardingStatus='pending'`) → 5-step `OnboardingWizard.jsx` (persona → modules → integration intents → branding → custom-domain intent) → `POST /api/admin/onboarding` runs `api/_lib/onboardingSeeder.js` (branding + tiers + integration intents + persona seed pack tagged `is_sample=true`). Legacy admins skip the wizard (backfilled to `onboarding_status='complete'`). Dashboard shows `OnboardingChecklist.jsx` with milestone progress.
-   **iSaaSi tenant (`isaasi.co.uk`):** Tenant `ffde35e5-c692-476b-900e-c3ad323e4b32` (slug `isaasi`, free plan, complete). Admin: `mat@teeone.co.uk`. Homepage is a published Canvas Builder page (`i_edit_page` slug `home`, id `0e619e68-b807-4ecd-9b16-2f4db8fe2c5d`) with 10 stacked sections. Contact form uses tenant email template `7d047a0a-b93c-4503-a342-52a500065264`. Reprovision: `node scripts/provision-isaasi-tenant.mjs` and `provision-isaasi-contact.mjs` (idempotent, need `SUPABASE_URL`/`SUPABASE_SERVICE_KEY` mirrors of the `DEST_*` vars). DNS handoff: CNAME `isaasi.co.uk` to the Vercel deployment; `api/_lib/tenantResolver.js` (strips `www.`) routes automatically.
-   **Accessibility audits:** Admin page `Accessibility Audits` (RBAC permission `admin.accessibility-audits`) runs axe-core 4.10 via browserless.io for tenant-supplied public URLs. Results stored in `accessibility_audit` / `accessibility_audit_result`. Endpoints under `/api/admin/accessibility-audits`; runner helper `api/_lib/browserlessAxe.js`. v1 limits: ≤10 URLs/run, http(s) only, no credentialed URLs.

## Product
-   **Core:** Members, Events, Bookings, Resources, Blog.
-   **Identity:** Unified login, multi-tenant ownership, organization memberships, granular access control.
-   **Customization:** Page Builder, Custom Forms with conditional logic, Workflow Automation, per-tenant branding.
-   **Financials:** Stripe membership payments, Xero/QBO invoicing, Fundraising with Gift Aid.
-   **Comms:** Email templates, campaigns, member preferences.
-   **Integrations:** WordPress Sync, Zoom (events/sessions), Zoho CRM sync.
-   **Reporting:** Due Diligence Reports, configurable Member/Org Directories.
-   **Community:** Tenant-scoped forums, Member Group email campaigns.

## User preferences
Preferred communication style: Simple, everyday language.

## Gotchas
-   **`dev.iconn.app` = Vercel preview deployment** built from the `dev` git branch of the same Vercel project as production. Shares the same Supabase. (a) Vercel's Functions → Logs viewer defaults to Production and silently hides Preview logs — switch the Environment filter to Preview. (b) A fix only reaches `dev.iconn.app` after the commit is on the `dev` branch and that branch's preview build has finished — redeploying main doesn't redeploy dev.
-   **`sendEmail()` never throws.** It catches Mailgun errors and returns `{ success: false, error, status, domain }`. Callers MUST inspect the return value; a bare `try { await sendEmail(...) } catch {}` will falsely report success on 401 / unverified domain / missing key. Canonical pattern: `api/auth/request-admin-password-reset.js`.
-   **System emails MUST pass `systemEmail: true`** (or use `sendSystemEmail()`). Without it, a tenant with a verified custom sending domain would silently start having its admin reset / signup verification / billing emails sent from the tenant's own brand — wrong identity and confusing to the owner.
-   **API hard-fails** any TENANT- or ORGANIZATION-scoped request without a usable tenant context.
-   **Workflow `dd_owner` / `dd_owner_email` placeholders** are resolved via `resolveDdOwnerForSubmission` (`api/_lib/ddOwner.js`) only when the trigger caller passes `context.formSubmissionId` to `triggerWorkflows`. Without submission context they collapse to empty strings (no raw `{{dd_owner}}` token leaks).
-   **No server-side length validation on `event.summary` / `complex_event.summary`** — relies on client-side `event_summary_max_length` system setting (default 150).

## Pointers
-   **React:** `https://react.dev/`
-   **Tailwind:** `https://tailwindcss.com/docs`
-   **Drizzle:** `https://orm.drizzle.team/docs/overview`
-   **Vercel Functions:** `https://vercel.com/docs/functions/overview`
-   **Supabase:** `https://supabase.com/docs`
-   **Stripe:** `https://stripe.com/docs/api`
-   **Mailgun:** `https://documentation.mailgun.com/en/latest/api_reference.html`
