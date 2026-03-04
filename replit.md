# Overview
This project is a multi-tenant SaaS platform designed for comprehensive membership management. It unifies member, event, booking, resource, and blog post management under a single system. Key capabilities include a unified identity system, dynamic page builder, custom forms with workflow automation, and a robust Due Diligence process. The platform operates on a three-tier hierarchy (TENANT, ORGANIZATION, MEMBER) ensuring strong access control and data isolation, aiming to streamline operations for organizations and capitalize on market opportunities.

# User Preferences
Preferred communication style: Simple, everyday language.

# System Architecture
## Core Technologies
The frontend is built with React 18 (TypeScript/JSX), Vite, TanStack Query, shadcn/ui (Radix UI), and Tailwind CSS. The backend uses Express.js, PostgreSQL, and Drizzle ORM, with API endpoints deployed as Vercel serverless functions.

## Multi-Tenant Architecture
Data isolation is enforced across GLOBAL, TENANT, ORGANIZATION, and MEMBER levels using `tenant_id` and `organization_id` for scoping.

## API Authentication Pattern
Authentication supports both Member (portal) and Tenant user (admin dashboard) sessions, managed by `getTenantContext(req)`.

## Identity and Access Management
A unified identity system handles user authentication, multiple tenant ownership, and organization memberships. It includes per-tenant password isolation, Google OAuth, and a feature-based role management system for granular control over UI visibility and backend access, with role-based field access control.

## Deployment & Domain Structure
The application is deployed on Vercel, utilizing `iconn.app` for tenant owner management and `{tenant}.iconn.app` for member portals. A tenant resolver (`api/_lib/tenantResolver.js`) handles domain-to-tenant mapping and URL building.

## Key Features
-   **Core Data Model:** Includes Member, Organization, Role, and TeamMember entities.
-   **Content Management:** Features event/booking management, general content management, a dynamic page builder with advanced timeline elements, custom forms with conditional logic and uniqueness validation, and blog posts.
-   **Form Uniqueness Validation:** Supports various comparison modes (`equals`, `contains`, `domain_equals`, etc.) for fields, checking against entity tables and previous submissions, scoped by `tenant_id`.
-   **Membership Payment Form Element:** Integrates a Stripe payment element for outstanding membership fees, supporting auto-submission upon successful payment. Form email notifications support an "Attach Invoice" toggle (per-email) that attaches the Xero invoice PDF when a membership payment field is present.
-   **Communication:** Includes an email template system, communication preferences, multi-audience email campaign targeting, and the ability to save audience segment rules as reusable lists.
-   **Workflow Automation:** Provides tenant-scoped workflows for automating actions such as sending emails, updating fields, creating contracts, managing memberships, and Due Diligence processes.
-   **Field Visibility Rules:** Implements conditional show/hide rules for fields and cards on organisation and member detail views, based on AND/OR logic. Member custom fields (preference fields) support role-based visibility via `my_preferences_role_ids` (JSONB on `preference_field` table): null/empty = all roles, array of role UUIDs = restricted. Filtering applied in `Preferences.jsx` (member-facing) and `MemberPreferences.jsx` (admin config). Admin UI in `CustomFieldsAdmin.jsx` provides a multi-select role picker when My Preferences toggle is on.
-   **Branding & Customization:** Supports per-tenant branding for public-facing pages and embeddable forms.
-   **Page Builder Timeline:** Advanced timeline element with unified/split background modes (solid, gradient, image with overlay), independent navigation panel and content panel backgrounds, item-level highlight styling, fullscreen overlay view, configurable first marker offset, label positioning (below/left), sub-year branching with diagonal SVG line paths, per-sub-marker pixel offset positioning (offset_x/offset_y from center line with timeline-level defaults), and per-sub-marker label side (left/right/below).
-   **Data Management:** Incorporates server-side pagination and a data migration system.
-   **Email Domain Provisioning:** Automates Mailgun domain provisioning for each tenant.
-   **Realtime Updates:** Utilizes Supabase Realtime Subscriptions for frontend cache invalidation.
-   **Booking System:** Features an agent booking system with tenant-scoped meeting templates.
-   **Resource View Tracking:** Tracks unique views per user per resource.
-   **Organisation Membership Tab:** Displays a rolling two-year cost preview with detailed breakdown, integrating with Xero for invoice generation.
-   **Fundraising Module:** Supports tenant-scoped campaigns with team members, unique donation pages, Stripe payment processing, UK Gift Aid, and AI-suggested content.
-   **Dynamic Directory:** Configurable member/organisation directories with slug-based URLs and server-side filtering. Member Directory Settings (`MemberDirectorySettings.jsx`) supports toggling both core fields and custom fields (preference fields with `show_in_member_directory` flag). Custom field toggle state stored in `custom_fields` object within the `member_directory_display` system setting. Both `MemberDirectory.jsx` and `DynamicDirectoryView.jsx` render enabled custom field values with type-aware formatting (picklist, dropdown, boolean, date) on member cards (up to 3 fields) and detail popups (all fields). Preference value map uses `pv.field_id || pv.preference_field_id` for DB column compatibility.
-   **Bookmarking System:** Allows members to bookmark content with drag-and-drop reordering.
-   **Forum Module:** Provides tenant-scoped discussion forums with role-managed access, threaded discussions, and moderation.

## Event Timezone Handling
Event times are stored in UTC with a separate timezone field for display, prioritizing Zoom, then event-specific, then 'Europe/London'.

## Membership Tier System
Supports membership pricing based on organization or member attributes with historical versioning, multi-structure support, configurable discounts, pro-rata pricing, free periods, and rollover discounts. It includes flat-rate pricing with VAT configuration.
-   **Scope Types:** Tiers can be scoped to `organization` or `member`, with member-scoped tiers offering auto-approval and online card payment flags. Each tier config supports an optional `invoice_address_field_id` (UUID, custom field) or `invoice_address_field_name` (TEXT, core field) to configure which field provides the invoice address for Xero invoices. Resolved via `api/_lib/invoiceAddressResolver.js`.
-   **Invoice Recipients:** Org-scoped tier configs support `invoice_email_field_name` (TEXT, e.g. `invoicing_email`) and `invoice_recipient_role_ids` (JSONB, array of role UUIDs). When invoices are generated (CRON or manual), `sendMembershipInvoiceEmail` in `api/_lib/membershipInvoiceEmail.js` resolves recipients from the configured email field + members with the selected roles scoped to the specific organisation. Configured in Step 1 (Scope) of `MembershipTierManagement.jsx`.
-   **Member Simulation & Configuration:** Provides functions for simulating membership costs for individual members and resolving member-specific configurations based on core or custom fields.
-   **Member Invoicing & Fees:** Handles member invoicing settings, manual renewals, fee approval, and provides a portal for members without organizations to manage their fees.
-   **Admin UI Integration:** Displays comprehensive membership information, invoicing controls, simulation/override options, and history within the member detail view for members not associated with organizations.
-   **Cron Renewals:** Automates processing of both organization-based and member-based renewals.

## UI/UX
The frontend employs a custom "new-york" design system, leveraging shadcn/ui (Radix UI) and Tailwind CSS to ensure a consistent, responsive user experience with a collapsible sidebar.

# Database Connection Instructions
⚠️ NEVER REMOVE THIS SECTION - These instructions are essential for database access ⚠️

This project uses Supabase PostgreSQL databases. Direct psql commands and execute_sql_tool DO NOT WORK on Replit due to IPv6 connectivity issues.

## Available Database Secrets
- `SOURCE_DATABASE_URL` — Legacy single-tenant Supabase (original data source for migrations)
- `DEST_DATABASE_URL` — New multi-tenant Supabase (production destination database)
- `DEST_SUPABASE_KEY` — New multi-tenant Supabase service role key for Supabase client
- `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` — Used by the app at runtime (points to SOURCE in Replit dev, DEST in Vercel prod)

## How to Query the Database
USE NODE.JS SCRIPTS with Supabase client — NOT psql or execute_sql_tool:
```js
import { createClient } from '@supabase/supabase-js';
const supabase = createClient('https://lvmzliemqnieeoruhkik.supabase.co', process.env.DEST_SUPABASE_KEY);
```
- Tenant ID: `fd82da65-aab7-4a5c-85b8-b2febeb2003d`
- See `scripts/debug-tenant.mjs` for a working example

## Soft-Deleted Members
Members are soft-deleted by changing their email to `deleted_<uuid>@deleted.local`. The utility `isDeletedMember()` in `client/src/utils/index.ts` checks for this pattern. Server-side queries should exclude these with `.not('email', 'like', 'deleted_%@deleted.local')`.

# External Dependencies
-   **Supabase:** PostgreSQL database and file storage.
-   **Stripe:** Payment processing, supporting per-feature test/live mode switching.
-   **Xero:** Invoice generation.
-   **Microsoft Graph API:** Outlook email integration.
-   **Mailgun:** Tenant-specific email sending, delivery, and native Email Marketing System (EMS).
-   **Zoho Campaigns:** Syncing member communication preferences.