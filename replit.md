# Membership Management Platform
A multi-tenant SaaS platform unifying member, event, booking, resource, and blog post management for organizations.

## Run & Operate
-   **Run Dev Server:** `npm run dev`
-   **Build:** `npm run build`
-   **Typecheck:** `npm run typecheck`
-   **Codegen:** `npm run codegen`
-   **DB Push:** `npx drizzle-kit push:pg` (or `npm run db:push`) — only works from environments with IPv6 outbound; **not from this Replit workspace** (see "Database connection").
-   **Migrations:** every `.sql` in `supabase/migrations/` is idempotent and applied against `DEST_DATABASE_URL` (pooler). Most migrations have a matching `node scripts/apply-*.mjs` runner; check `scripts/` before applying anything by hand.
-   **One-off scripts (backfills, CSV imports, tenant seeds):** live in `scripts/` (e.g. `recompute-tenant-storage.mjs`, `backfill-*.mjs`, `import-*.mjs`, `seed-*.mjs`). They are idempotent, default to dry-run unless an `--apply` flag is passed, and many are hard-pinned to a single tenant. Read the script header before running; each documents its own flags and scope.
-   **Storage usage reconcile:** `node scripts/recompute-tenant-storage.mjs [--dry-run] [--tenant=<uuid>]`, or trust the nightly cron at `/api/cron/recompute-tenant-storage` (03:00 UTC, `CRON_SECRET`-guarded).

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
| `R2_ACCOUNT_ID` | Cloudflare account ID — used to build the R2 endpoint URL (`https://<id>.r2.cloudflarestorage.com`). Set this **or** `R2_ENDPOINT`. Must be added as a Vercel secret. |
| `R2_ENDPOINT` (opt) | Full R2 endpoint URL override. Use instead of `R2_ACCOUNT_ID` if you prefer an explicit URL. |
| `R2_ACCESS_KEY_ID` | R2 API token Access Key ID. Must be added as a Vercel secret. |
| `R2_SECRET_ACCESS_KEY` | R2 API token Secret Access Key. Must be added as a Vercel secret. |
| `R2_BUCKET` | Target R2 bucket name for backups. Must be added as a Vercel secret. |
| `DB_BACKUP_SCHEMAS` (opt) | Comma-separated Postgres schemas to include in the nightly database dump (default: `public`). Supabase internal schemas — `auth`, `storage`, `realtime`, etc. — are managed by Supabase's own infrastructure and intentionally excluded. |

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
-   **Email sending:** `api/_lib/emailService.js` resolves the sending domain off `tenantId` for tenant→member emails. **System emails** (platform→tenant-owner: admin reset, signup verification, team invite, billing notifications) MUST pass `systemEmail: true` (or use `sendSystemEmail()`); this forces both Mailgun domain AND From identity to `mail.${APP_DOMAIN}` / `noreply@mail.${APP_DOMAIN}`. System reset/verification links must point at `${APP_DOMAIN}/...` not a tenant subdomain.
-   **Dynamic SEO:** SSR meta-tag injection per-tenant via `api/render.js`; per-page metadata resolved by `api/_lib/entityMeta.js`. Per-entity `seo_title` / `seo_description` / `og_image_url` overrides on events, blog posts, news, campaigns, resources, and directories (UI in `client/src/components/blog/SEOSettings.jsx`). `og:image` URLs on `vault.iconn.app` or `*.supabase.co` are proxied through `/api/og-image`.
-   **Event deletion:** Multi-step cancellation flow (refunds, reinstatements, Zoom unregistration) before any data purge. Direct deletion of events is deprecated for UI flows.
-   **Semantic `warning` color:** `--warning` / `--warning-foreground` CSS vars in `client/src/index.css` (both themes, WCAG-AA). Use `text-warning`, `bg-warning`, `<Badge variant="warning">`, `<Alert variant="warning">` instead of raw amber/yellow/orange palette classes.
-   **Membership invoices:** `organisation_membership_history` / `member_membership_history` carry `payment_status` (`unpaid`/`paid`/`partial`/`voided`) + `paid_at`, separate from the lifecycle `status`. Accounting-sync failures flag the row `accounting_sync_status='failed'` (not swallowed) with a Retry button in `OrgMembershipTab.jsx`. Payment reconciliation cron `/api/cron/reconcile-membership-invoice-payments` (every 3h, `CRON_SECRET`-guarded) queries Xero/QBO and fires workflows on `unpaid -> paid` only. See `api/_lib/membershipPaymentReconciliation.js`, `api/_lib/accountingProvider.js`.
-   **Tenant storage metering:** `tenant.storage_used_bytes` (BIGINT) drives `checkStorageQuota` (`api/_lib/planQuota.js`) and `/admin/plan-usage`. Maintained incrementally via `addTenantStorageBytes` (`api/_lib/tenantStorageUsage.js`). Can drift (signed-URL claimed size); re-baseline with `scripts/recompute-tenant-storage.mjs` or the nightly cron.
-   **Paid-plan upgrade flow (`/admin/plan-usage` → Stripe Checkout):** `PlanUsage.jsx` → `api/admin/plan-checkout.js` (tenant-admin RBAC, uses PLATFORM `STRIPE_SECRET_KEY`, NOT tenant's connected Stripe). First-time creates a Checkout Session; existing live sub swaps price in place via `stripe.subscriptions.update` (proration, never a parallel sub). Webhook `api/webhooks/stripe-plan.js` upserts `tenant_subscription` and flips `tenant.plan_code` only when status is `active`/`trialing`; `subscription.deleted` reverts to `free`.
-   **Self-serve signup & onboarding (`/signup` → wizard):** `signup-start.js` (captcha + rate limits + verification email) → `signup-verify.js` (`provisionTenant`, `free` plan) → 5-step `OnboardingWizard.jsx` → `POST /api/admin/onboarding` runs `api/_lib/onboardingSeeder.js` (branding + tiers + persona seed pack tagged `is_sample=true`). Legacy admins backfilled to `onboarding_status='complete'`.
-   **Accessibility audits:** Admin page (RBAC `admin.accessibility-audits`) runs axe-core 4.10 via browserless.io for tenant public URLs. Results in `accessibility_audit` / `accessibility_audit_result`; endpoints under `/api/admin/accessibility-audits`; runner `api/_lib/browserlessAxe.js`. v1 limits: ≤10 URLs/run, http(s) only, no credentialed URLs.

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
-   **`dev.iconn.app` = Vercel preview deployment** built from the `selfserve2` git branch of the same Vercel project as production. Shares the same Supabase. (a) Vercel's Functions → Logs viewer defaults to Production and hides Preview logs — switch the Environment filter to Preview. (b) A fix only reaches `dev.iconn.app` after the commit is on the `selfserve2` branch and that branch's preview build has finished.
-   **`sendEmail()` never throws.** It catches Mailgun errors and returns `{ success: false, error, status, domain }`. Callers MUST inspect the return value; a bare `try { await sendEmail(...) } catch {}` will falsely report success on 401 / unverified domain / missing key. Canonical pattern: `api/auth/request-admin-password-reset.js`.
-   **System emails MUST pass `systemEmail: true`** (or use `sendSystemEmail()`). Without it, a tenant with a verified custom sending domain would silently send admin reset / signup / billing emails from the tenant's own brand — wrong identity.
-   **API hard-fails** any TENANT- or ORGANIZATION-scoped request without a usable tenant context.
-   **Workflow `dd_owner` / `dd_owner_email` placeholders** resolve via `resolveDdOwnerForSubmission` (`api/_lib/ddOwner.js`) only when the trigger caller passes `context.formSubmissionId` to `triggerWorkflows`. Without submission context they collapse to empty strings.
-   **No server-side length validation on `event.summary` / `complex_event.summary`** — relies on client-side `event_summary_max_length` system setting (default 150).

## Pointers
-   **React:** `https://react.dev/`
-   **Tailwind:** `https://tailwindcss.com/docs`
-   **Drizzle:** `https://orm.drizzle.team/docs/overview`
-   **Vercel Functions:** `https://vercel.com/docs/functions/overview`
-   **Supabase:** `https://supabase.com/docs`
-   **Stripe:** `https://stripe.com/docs/api`
-   **Mailgun:** `https://documentation.mailgun.com/en/latest/api_reference.html`
