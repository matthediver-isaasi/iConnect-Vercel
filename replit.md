# Membership Management Platform
A multi-tenant SaaS platform unifying member, event, booking, resource, and blog post management for organizations.

## Run & Operate
-   **Run Dev Server:** `npm run dev`
-   **Build:** `npm run build`
-   **Typecheck:** `npm run typecheck`
-   **Codegen:** `npm run codegen`
-   **DB Push:** `npx drizzle-kit push:pg` (or `npm run db:push`)
-   **Env Vars:** `DATABASE_URL`, `STRIPE_SECRET_KEY`, `XERO_CLIENT_ID`, `MAILGUN_API_KEY`, `VITE_APP_URL`

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
-   **Dynamic SEO:** Server-side rendering (SSR) of HTML for link previews and SEO, with dynamic replacement of meta tags based on tenant context.
-   **Identity Management:** Unified identity system with per-tenant password isolation, Google OAuth, and feature-based role management.
-   **Event Deletion Safety:** Event deletion uses a cancellation flow that ensures refunds, reinstatements, and Zoom unregistration are processed before event data is purged.
-   **Strict Tenant Context:** Shared entity API hard-fails requests without a valid tenant context to prevent cross-tenant data leaks.

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
-   The workflow runner strips `dd_owner` placeholders to empty if no submission context is available, preventing token leaks.
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