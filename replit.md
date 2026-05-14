# Membership Management Platform
A multi-tenant SaaS platform unifying member, event, booking, resource, and blog post management for organizations.

## Run & Operate
-   **Run Dev Server:** `npm run dev`
-   **Build:** `npm run build`
-   **Typecheck:** `npm run typecheck`
-   **Codegen:** `npm run codegen`
-   **DB Push:** `npx drizzle-kit push:pg` (or `npm run db:push`)
-   **Env Vars:** `DATABASE_URL`, `STRIPE_SECRET_KEY`, `XERO_CLIENT_ID`, `MAILGUN_API_KEY`, `VITE_APP_URL`, `BROWSERLESS_API_TOKEN` (powers Accessibility Audits via browserless.io; optional `BROWSERLESS_BASE_URL`, `BROWSERLESS_AUDIT_TIMEOUT_MS`)

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
-   **Accessibility Audits:** Admin page `Accessibility Audits` (RBAC permission `admin.accessibility-audits`) drives axe-core scans via browserless.io for tenant-supplied public URLs. Results are stored per tenant in `accessibility_audit` / `accessibility_audit_result` with severity counts (critical/serious/moderate/minor), pass/violation totals, score, and the full axe JSON. Endpoints under `/api/admin/accessibility-audits` (`api/admin/accessibility-audits/index.js`, `[id].js`) hard-fail without tenant context and check `hasFeatureAccess(roleId, 'admin.accessibility-audits')`. Runner helper: `api/_lib/browserlessAxe.js` (HTTP `/function` endpoint, axe-core 4.10 injected from CDN). v1 limits: ≤10 URLs/run, http(s) only, no credentials in URL, per-URL timeout from `BROWSERLESS_AUDIT_TIMEOUT_MS` (default 60s). Out of scope for v1: scheduled audits, site crawling, authenticated pages, PDF export, trend charts.

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