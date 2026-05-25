# Membership Management Platform
A multi-tenant SaaS platform unifying member, event, booking, resource, and blog post management for organizations.

## Run & Operate
-   **Run Dev Server:** `npm run dev`
-   **Build:** `npm run build`
-   **Typecheck:** `npm run typecheck`
-   **Codegen:** `npm run codegen`
-   **Apply Accounting Migrations:** `node scripts/apply-accounting-migrations.mjs` — applies `supabase/migrations/20260525_accounting_provider_phase1.sql`, `20260525_backfill_accounting_provider_xero.sql`, and `20260525_membership_history_payment_status.sql` to the destination Supabase via `DEST_DATABASE_URL` (pooler, IPv4-reachable from this workspace) inside a single transaction. All files are idempotent so re-running is safe.
-   **Backfill Membership Payment Status (one-off, run BEFORE enabling the reconciliation cron in prod):** `node scripts/backfill-membership-payment-status.mjs [--dry-run] [--tenant=<uuid>] [--table=organisation_membership_history|member_membership_history] [--limit=N]` — silently flips historic paid/voided invoices to `payment_status='paid'`/`'voided'` without firing workflows (option b chosen for task #1017). Idempotent.
-   **DB Push:** `npx drizzle-kit push:pg` (or `npm run db:push`) — note this only works from environments with IPv6 outbound (see "Database connection" below); it will not run from this Replit workspace.
-   **Env Vars:** `DATABASE_URL` (the Supabase direct host — IPv6 only, see "Database connection"), `STRIPE_SECRET_KEY`, `XERO_CLIENT_ID`, `MAILGUN_API_KEY`, `VITE_APP_URL`, `BROWSERLESS_API_TOKEN` (powers Accessibility Audits via browserless.io; optional `BROWSERLESS_BASE_URL`, `BROWSERLESS_AUDIT_TIMEOUT_MS`), optional `QUICKBOOKS_REDIRECT_URI` (overrides the default `${origin}/api/quickbooks/callback` used by the QBO OAuth flow — handy for forcing a stable redirect URI that matches the one registered in the Intuit Developer Portal)

## Database connection
There are two Supabase projects this codebase talks to:

| Role | What it is | URL secret | Postgres URL secret | Service-role key secret |
| ---- | ---------- | ---------- | ------------------- | ----------------------- |
| **Destination (current prod)** | Multi-tenant iConnect DB | `DEST_SUPABASE_URL` (`https://lvmzliemqnieeoruhkik.supabase.co`) | `DEST_DATABASE_URL` | `DEST_SUPABASE_KEY` |
| **Source (legacy)** | Pre-multi-tenancy single-tenant snapshot, used by migration scripts | `SOURCE_SUPABASE_URL` | `SOURCE_DATABASE_URL` | `SOURCE_SUPABASE_KEY` |

Important: **The Supabase direct host (`db.<project>.supabase.co`) is unreachable from this Replit workspace** — it publishes only IPv6 (AAAA) DNS and the Replit container has no IPv6 outbound route, so `psql`, `execute_sql_tool`, `drizzle-kit push`, and any raw `pg`/Drizzle client pointed at the direct host fail with `ENOTFOUND` / `ENETUNREACH`. Those tools still work from Vercel functions, the user's laptop, and CI — just not from here against the direct host.

However, **the Supabase Pooler hostname IS IPv4-reachable from this workspace** (`aws-1-eu-central-1.pooler.supabase.com:5432`, which is what `DEST_DATABASE_URL` already points to). That means `pg` clients using `DEST_DATABASE_URL` (transaction-pooler mode) DO work from Replit for both read and write queries and for DDL such as `CREATE INDEX` — used e.g. by `scripts/seed-bnms-typography.mjs` and the `20260519_typography_style_default_per_tenant.sql` migration in task #939. Prefer `@supabase/supabase-js` for ordinary CRUD (more ergonomic, REST-based), and reach for `pg` via `DEST_DATABASE_URL` only when you need raw SQL / DDL the REST API can't do.

For any DB access from this workspace (scripts, ad-hoc debugging, one-off data fixes), use **`@supabase/supabase-js`** with the service-role key. The HTTPS REST endpoint is IPv4-reachable. A working reference is `scripts/debug-tenant.mjs`:

```js
import { createClient } from '@supabase/supabase-js';
const supabase = createClient(
  process.env.DEST_SUPABASE_URL,
  process.env.DEST_SUPABASE_KEY
);
const tenantId = 'fd82da65-aab7-4a5c-85b8-b2febeb2003d'; // canonical tenant id used by migrations
```

When writing migration/admin scripts, resolve the URL + key defensively (some older scripts use `DEV_SUPABASE_URL` / `DEV_SUPABASE_SERVICE_KEY` or plain `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` — those may still be set, but prefer the `DEST_*` names above for new code).

## Stack
-   **Frontend:** React 18 (TypeScript/JSX), Vite, TanStack Query, shadcn/ui (Radix UI), Tailwind CSS
-   **Backend:** Express.js, PostgreSQL, Drizzle ORM
-   **Deployment:** Vercel (serverless functions)
-   **Runtime:** Node.js (Vercel)

## Where things live
-   `/client`: Frontend source code
-   `/api`: Backend API endpoints (Vercel serverless functions)
-   `/supabase`: Database migrations (`/supabase/migrations`), RLS policies, and functions
-   `/scripts`: Utility and migration scripts
-   `client/index.html`: Main HTML file, handles SEO/OG tag injection via `api/render.js`
-   `supabase/schema.prisma`: Database schema (source of truth for Drizzle)
-   `client/src/design-system`: Custom "new-york" design system components

## Architecture decisions
-   **Multi-tenancy:** Data isolation enforced at GLOBAL, TENANT, ORGANIZATION, and MEMBER levels using `tenant_id` and `organization_id`.
-   **Dynamic SEO:** Server-side rendering (SSR) of HTML for link previews and SEO, with dynamic replacement of meta tags based on tenant context. Per-page metadata is resolved by `api/_lib/entityMeta.js` which covers (a) per-entity detail pages for events, complex events, jobs, forum threads, resources, dynamic directories, photo galleries, fundraising campaigns, member profiles, public forms, news, and blog articles — events, complex events, blog posts, news, fundraising campaigns, resources, and dynamic directories all honor per-entity `seo_title` / `seo_description` / `og_image_url` overrides (mirroring the IEditPage pattern) and fall back to auto-derived title/summary/feature image, then tenant defaults; (b) IEditPage CMS pages built with the page builder (matched on top-level `/:slug` routes; only published `public`/`hybrid` pages unfurl; honors per-page `seo_title`/`seo_description`/`og_image_url` overrides and falls back to hero text/image extracted from page elements using the same field lists as `api/public/prerender.js`); and (c) section/list routes (`/Events`, `/Articles`, `/Resources`, `/JobBoard`, `/Forum`, `/CampaignsPage`, `/PhotoGalleries`, `/MemberDirectory`, `/PublicAbout`, `/PublicContact`) via `LIST_ROUTE_META`. `og:image` URLs hosted on `vault.iconn.app` or `*.supabase.co` are rewritten to a same-origin `/api/og-image?url=…` proxy (`api/og-image.js`, host-allow-listed, ≤5 MB, image content-types only) so social unfurl bots aren't blocked by Cloudflare bot management or `x-robots-tag: none`. The shared `client/src/components/blog/SEOSettings.jsx` editor card renders the title / description fields plus the social-image upload UI for every editor that exposes social-sharing settings (events, complex events, articles, news, campaigns, resources, dynamic directories).
-   **Identity Management:** Unified identity system with per-tenant password isolation, Google OAuth, and feature-based role management.
-   **Event Deletion Safety:** Event deletion uses a cancellation flow that ensures refunds, reinstatements, and Zoom unregistration are processed before event data is purged.
-   **Strict Tenant Context:** Shared entity API hard-fails requests without a valid tenant context to prevent cross-tenant data leaks.
-   **Semantic `warning` Color Token:** A `--warning` / `--warning-foreground` CSS variable pair is defined in `client/src/index.css` for both `:root` and `.dark` (light: amber-700-equivalent, dark: amber-300/400-equivalent) and exposed via Tailwind as `warning` / `warning-foreground` (so `text-warning`, `bg-warning`, `border-warning`, `text-warning-foreground` all work). `Badge` and `Alert` (`client/src/components/ui/badge.jsx`, `alert.jsx`) expose a `warning` variant. New warning-style text/badges/alerts MUST use `text-warning` or `<Badge variant="warning">` / `<Alert variant="warning">` instead of raw `text-amber-*` / `text-yellow-*` / `text-orange-*` palette classes so we control warning contrast in one place and both themes pass WCAG AA.
-   **Membership Invoice Payment Reconciliation:** Per-year membership history rows (`organisation_membership_history`, `member_membership_history`) carry a `payment_status` (`unpaid`/`paid`/`partial`/`voided`) and `paid_at` timestamp tracking the underlying accounting invoice — separate from the existing `status` column which represents the row's membership-year lifecycle (`active`/`cancelled`). A cron at `/api/cron/reconcile-membership-invoice-payments` (every 3 hours, `CRON_SECRET`-guarded) batches across tenants, asks each row's `accounting_provider` (Xero or QBO) for the current invoice status via `provider.fetchInvoiceStatus(invoiceId, appTenantId)` in `api/_lib/accountingProvider.js`, writes the new state, and fires the workflow engine via `triggerWorkflows` with `triggerType='field_change'` on `unpaid -> paid` transitions only. Org-level invoices fire workflows against the `organization` entity; member-level invoices against `member`. The `afterData` payload exposes `payment_status`, `paid_at`, `last_membership_invoice_number`, `last_membership_invoice_paid_at`, plus `accounting_invoice_id`/`accounting_invoice_number`/`accounting_provider`/`membership_year`/`final_cost`/`currency` so workflow conditions and email templates can reference them. These synthetic fields are exposed in `client/src/pages/WorkflowManagement.jsx`'s org/member core-field pickers so admins can author conditions like `payment_status changed_to paid`. The shared helper `api/_lib/membershipPaymentReconciliation.js` is also called inline from the Stripe → Xero/QBO path in `api/public/membership-fees/[token].js` so portal payments fire workflows immediately rather than waiting for the cron. Admins can also click a "Check now" refresh icon next to View/Download in the Membership Fee History card (`OrgMembershipTab.jsx`) which POSTs to `api/admin/membership-payment-reconcile.js` (tenant-admin RBAC, same gate as renewals) and reconciles a single row on demand. A `Paid`/`Unpaid`/`Partial`/`Voided` badge sits alongside the lifecycle badge in the Status column on both `OrgMembershipTab.jsx` and `MemberMembershipTab.jsx`. Cron caps at 500 rows/run and exits early at 50s elapsed to stay within Vercel's 60s function limit (older `created_at` first; unfinished rows pick up on the next tick). The one-off historic backfill (`scripts/backfill-membership-payment-status.mjs`) bypasses the shared helper and writes the DB directly so workflows do NOT fire for already-paid historic invoices (option b chosen by user). Out of scope for v1: real-time Xero/QBO webhooks, firing on `partial`, reconciling non-membership invoices, and the workflow entity_type extension for a dedicated "membership invoice" entity.
-   **Accessibility Audits:** Admin page `Accessibility Audits` (RBAC permission `admin.accessibility-audits`) drives axe-core scans via browserless.io for tenant-supplied public URLs. Results are stored per tenant in `accessibility_audit` / `accessibility_audit_result` with severity counts (critical/serious/moderate/minor), pass/violation totals, score, and the full axe JSON. Endpoints under `/api/admin/accessibility-audits` (`api/admin/accessibility-audits/index.js`, `[id].js`) hard-fail without tenant context and check `hasFeatureAccess(roleId, 'admin.accessibility-audits')`. Runner helper: `api/_lib/browserlessAxe.js` (HTTP `/function` endpoint, axe-core 4.10 injected from CDN; `axe.run` is invoked with an explicit context-spec object `{ include: [document.documentElement] }` so axe-core 4.10's `normalizeRunParams` reliably classifies the first arg as context, avoiding the "axe.run arguments are invalid" error). v1 limits: ≤10 URLs/run, http(s) only, no credentials in URL, per-URL timeout from `BROWSERLESS_AUDIT_TIMEOUT_MS` (default 60s). Out of scope for v1: scheduled audits, site crawling, authenticated pages, PDF export, trend charts.

## Product
-   **Core Platform:** Member, Event, Booking, Resource, Blog Management.
-   **User Identity:** Unified login, multi-tenant ownership, organization memberships, granular access control.
-   **Customization:** Dynamic Page Builder, Custom Forms with conditional logic, Workflow Automation, per-tenant branding.
-   **Financials:** Stripe integration for membership payments, Xero for invoicing, Fundraising Module with Gift Aid.
-   **Communication:** Email template system, campaigns, communication preferences.
-   **Integration:** WordPress Sync, Zoom integration for events/sessions, Zoho CRM sync.
-   **Reporting:** Due Diligence Reports with analytics, configurable Member/Organization Directories.
-   **Community:** Tenant-scoped discussion forums, Member Group email campaigns.

## User preferences
Preferred communication style: Simple, everyday language.

## Gotchas
-   The API hard-fails any TENANT- or ORGANIZATION-scoped request that arrives without a usable tenant context.
-   The workflow runner resolves `dd_owner` / `dd_owner_email` placeholders via `resolveDdOwnerForSubmission` (in `api/_lib/ddOwner.js`) when the trigger caller passes `context.formSubmissionId` to `triggerWorkflows` (e.g. the form processor in `api/forms/process-application.js` plumbs the originating DD `submission_id` for member/organization create triggers). When no submission context is available, placeholders collapse to empty strings, preventing raw `{{dd_owner}}` token leaks.
-   Event deletion is a multi-step cancellation process; direct deletion of events is deprecated for UI flows.
-   Server-side no length validation for `event.summary` and `complex_event.summary` - client-side `event_summary_max_length` (default 150) system setting is the primary control.

## Pointers
-   **React Docs:** `https://react.dev/`
-   **Tailwind CSS:** `https://tailwindcss.com/docs`
-   **Drizzle ORM:** `https://orm.drizzle.team/docs/overview`
-   **Vercel Serverless Functions:** `https://vercel.com/docs/functions/overview`
-   **Supabase Docs:** `https://supabase.com/docs`
-   **Stripe API:** `https://stripe.com/docs/api`
-   **Mailgun API:** `https://documentation.mailgun.com/en/latest/api_reference.html`