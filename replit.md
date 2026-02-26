# Overview
This project is a multi-tenant SaaS membership management platform designed to unify member, event, booking, resource, and blog post management for organizations. It features a unified identity system, dynamic page builder, custom forms, workflow automation, and a robust Due Diligence process. The platform is built on a three-tier hierarchy (TENANT, ORGANIZATION, MEMBER) with strong access control and data isolation, aiming to streamline organizational operations and offer significant market potential.

# User Preferences
Preferred communication style: Simple, everyday language.

# System Architecture
## Core Technologies
The frontend uses React 18 (TypeScript/JSX), Vite, TanStack Query, shadcn/ui (Radix UI), and Tailwind CSS. The backend uses Express.js, PostgreSQL, and Drizzle ORM, with API endpoints deployed as Vercel serverless functions.

## Multi-Tenant Architecture
The platform enforces data isolation across GLOBAL, TENANT, ORGANIZATION, and MEMBER levels using `tenant_id` and `organization_id` for scoping.

## API Authentication Pattern
Authentication supports both Member (portal) and Tenant user (admin dashboard) sessions, managed by `getTenantContext(req)`.

## Identity and Access Management
A unified identity system handles user authentication, multiple tenant ownership, and organization memberships, including per-tenant password isolation and Google OAuth. A feature-based role management system provides granular control over UI visibility and backend access, including protected system roles and role-based field access control.

## Deployment & Domain Structure
The application is deployed on Vercel, using `iconn.app` for tenant owner management and `{tenant}.iconn.app` for member portals. A tenant resolver (`api/_lib/tenantResolver.js`) handles domain-to-tenant mapping and URL building.

## Key Features and Modules
-   **Core Data Model:** Includes Member, Organization, Role, and TeamMember entities.
-   **Content Management:** Event/booking management, general content management, dynamic page builder (with timeline element supporting up to 5 images per date in a carousel via `media_items` array with backward compat for legacy single `media` field; timeline items support a "Highlight" mode with configurable card background (solid/gradient/image), text colour, and width as % of parent via `item.highlight` object; highlight cards also support alignment (left/centre/right when width < 100%), border (toggle, colour, width 1-6px, style solid/dashed/dotted), and shadow (none/sm/md/lg/xl/glow with configurable glow colour); highlighted items can use a custom marker shape via `marker_shape` field (circle, star, diamond, heart, hexagon, square, triangle, shield, crown, trophy, flag, bolt, flame, award, bookmark) rendered in both desktop rail and mobile inline dot; highlight markers also support `marker_color`, `marker_bg`, and `marker_border_color` for custom colour, background circle, and border ring), custom forms with conditional logic and uniqueness validation, and blog posts.
-   **Form Uniqueness Validation:** `api/forms/validate-uniqueness.js` supports comparison modes: `equals`, `equals_lowercase`, `contains`, `starts_with`, `ends_with`, `domain_equals` (email/URL domain extraction), and `url_equals` (normalises URLs stripping protocol/www/trailing slash for matching against `website_url`). Checks both entity tables and previous form submissions, scoped by `tenant_id`.
-   **Membership Payment Form Element:** `membership_payment` form field type in the form builder. Renders a Stripe payment element for outstanding membership fees. Uses `member_id` from URL query params to identify the member. Backend: `api/forms/membership-payment.js` handles fee lookup (GET), PaymentIntent creation (POST create_payment), and payment confirmation with history record creation (POST confirm_payment). Frontend: `client/src/components/forms/MembershipPaymentField.jsx`. Works in both `FormView.jsx` and `EmbedForm.jsx`. Tenant-isolated via `resolveTenantFromRequest`. Both form paths block submission until payment is completed.
-   **Communication:** Email template system, communication preferences, and multi-audience email campaign targeting.
-   **Workflow Automation:** Tenant-scoped workflows for automating actions like sending emails, updating fields, creating contracts, memberships, and managing Due Diligence processes.
-   **Branding & Customization:** Per-tenant branding for public-facing pages and embeddable forms.
-   **Data Management:** Server-side pagination and a robust data migration system.
-   **Email Domain Provisioning:** Automated Mailgun domain provisioning for each tenant.
-   **Realtime Updates:** Supabase Realtime Subscriptions for frontend cache invalidation.
-   **Booking System:** Agent booking system with tenant-scoped meeting templates.
-   **Resource View Tracking:** Tracks unique views per user per resource.
-   **Organisation Membership Tab:** Displays a rolling two-year cost preview with detailed breakdown, using `simulateMembershipForOrg()` for all cost calculations. Supports year-specific overrides and invoicing controls, including automatic, scheduled, and manual modes. Integrates with Xero for invoice generation.
-   **Fundraising Module:** Supports tenant-scoped campaigns with team members, unique donation pages, Stripe payment processing, UK Gift Aid, and a multi-step registration wizard. Fundraisers access dashboards via magic links, which merge campaigns from multiple tenants if applicable. Includes fundraiser updates, profile customization, and AI-suggested content.
-   **Bookmarking System:** Allows members to bookmark content with drag-and-drop reordering.
-   **Forum Module:** Provides tenant-scoped discussion forums with role-managed access, threaded discussions, reactions, reporting, and moderation.

## Event Timezone Handling
Event times are stored in UTC with a separate timezone field for display, prioritizing Zoom, then event-specific, then 'Europe/London'.

## Membership Tier System
Supports membership pricing based on organization OR member attributes with historical versioning, multi-structure support, and configurable discounts. Includes pro-rata pricing logic, free periods, and rollover discounts, with a go-live date determining discount application. The tier management UI uses a 6-step wizard for configuration. Flat-rate pricing supports a `flat_vat_rate` field (JSON `{taxType, name}`) on `membership_tier_config`, selectable via Xero-synced VAT rates in the Pricing step; applied in both org and member simulations and included in Stripe payment totals.
-   **Scope Types:** Each tier config has `structure_scope_type` (`'organization'` or `'member'`). Member-scoped tiers are for members not linked to an organisation. Member-scoped configs support two additional flags: `auto_approve_fees` (auto-creates an approved `member_membership_invoicing` record when a matching member is created via form) and `online_card_payment` (hides renewal/PO invoicing controls in admin, showing a card payment message instead).
-   **Member Simulation:** `simulateMembershipForMember()` in `api/_lib/membershipSimulation.js` mirrors org simulation but uses member fields, `member_membership_history`, and `member_membership_invoicing` tables.
-   **Member Config Resolution:** `getConfigForMember()` in `api/_lib/membershipConfigResolver.js` matches configs with `structure_scope_type='member'` against member core fields (via `core:field_name` IDs) or custom fields.
-   **Member Invoicing:** `api/membership/member-membership-invoicing.js` handles GET/PUT/POST/PATCH for member invoicing settings, manual renewals, and fee approval.
-   **Member Fees Portal:** `api/membership/member-fees.js` routes members without orgs to member-scoped simulation and payment flows.
-   **Member Membership API:** `api/membership/member-membership.js` provides combined membership data (config, year costs, history, override metadata) for the admin member detail view.
-   **Member Membership Override:** `api/membership/member-membership-override.js` handles GET/POST/DELETE for member cost overrides (structure, price, discount) stored in `member_membership_override` table, with audit trail via `member_note`. GET falls back to general (null-year) overrides when year-specific not found.
-   **Cron Renewals:** `api/cron/process-membership-renewals.js` processes both org-based and member-based automatic/scheduled renewals.
-   **Admin UI:** `MemberMembershipTab.jsx` displays membership info, invoicing controls, simulate/override buttons, and history in the member detail view for members without organisations.
-   **Tables:** `member_membership_history` and `member_membership_invoicing` (parallel to org equivalents), entity-mapped as `MemberMembershipHistory` and `MemberMembershipInvoicing`.

## UI/UX
The frontend utilizes a custom "new-york" design system, leveraging shadcn/ui (Radix UI) and Tailwind CSS for a consistent, responsive user experience with a collapsible sidebar.

# External Dependencies
-   **Supabase:** PostgreSQL database and file storage.
-   **Stripe:** Payment processing. Supports per-feature test/live mode switching via `AdminIntegrations.jsx`. Tenants can store both live (`secret_key`, `publishable_key`) and test (`test_secret_key`, `test_publishable_key`) Stripe keys. Per-feature toggles (`stripe_mode_events`, `stripe_mode_membership`, `stripe_mode_jobs`) in the credentials JSONB control which key set each feature uses. `getStripeCredentials(tenantId, feature)` in `api/_lib/stripeCredentials.js` resolves the correct keys based on the feature's mode setting, falling back to live keys if test keys aren't configured.
-   **Xero:** Invoice generation.
-   **Microsoft Graph API:** Outlook email integration.
-   **Mailgun:** Tenant-specific email sending, delivery, and native Email Marketing System (EMS).
-   **Zoho Campaigns:** Syncing member communication preferences.

# Database Connection Instructions
⚠️ NEVER REMOVE THIS SECTION - These instructions are essential for database access ⚠️

This project uses Supabase PostgreSQL databases. Direct psql commands and execute_sql_tool DO NOT WORK on Replit due to IPv6 connectivity issues.

## Available Database Secrets
| Secret | Database | Purpose |
|--------|----------|---------|
| SOURCE_DATABASE_URL | Legacy single-tenant Supabase | Original data source for migrations |
| DEST_DATABASE_URL | New multi-tenant Supabase | Production destination database |
| DEST_SUPABASE_KEY | New multi-tenant Supabase | Service role key for Supabase client |

## How to Query the Database
USE NODE.JS SCRIPTS - NOT psql or execute_sql_tool

```javascript
import { createClient } from '@supabase/supabase-js';

// For destination (multi-tenant) database:
const supabaseUrl = 'https://lvmzliemqnieeoruhkik.supabase.co';
const supabaseKey = process.env.DEST_SUPABASE_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

const { data, error } = await supabase
  .from('member')
  .select('*')
  .eq('tenant_id', 'fd82da65-aab7-4a5c-85b8-b2febeb2003d')
  .limit(10);
```

## Important Notes
- Replit's built-in database tools won't work due to IPv6 routing issues
- Always use `@supabase/supabase-js` for all database operations
- Tenant ID for migrations: `fd82da65-aab7-4a5c-85b8-b2febeb2003d`
- See `scripts/debug-tenant.mjs` for a working example