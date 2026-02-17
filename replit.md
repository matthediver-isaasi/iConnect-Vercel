# Overview
This project is a multi-tenant SaaS membership management platform that unifies member, event, booking, resource, and blog post management for organizations. It features a unified identity system, dynamic page builder, custom forms, workflow automation, and a robust Due Diligence process, all built on a three-tier hierarchy (TENANT, ORGANIZATION, MEMBER) with strong access control and data isolation. The platform aims to streamline organizational operations and offers significant market potential.

# User Preferences
Preferred communication style: Simple, everyday language.

# System Architecture
## Core Technologies
The frontend uses React 18 (TypeScript/JSX), Vite, TanStack Query, shadcn/ui (Radix UI), and Tailwind CSS. The backend uses Express.js, PostgreSQL, and Drizzle ORM, with API endpoints deployed as Vercel serverless functions.

## Multi-Tenant Architecture
The platform is designed for multi-tenancy, ensuring data isolation across GLOBAL, TENANT, ORGANIZATION, and MEMBER levels using `tenant_id` and `organization_id` for scoping.

## API Authentication Pattern
Authentication supports both Member (portal) and Tenant user (admin dashboard) sessions, managed by `getTenantContext(req)`.

## Identity and Access Management
A unified identity system manages user authentication, multiple tenant ownership, and organization memberships, including per-tenant password isolation and Google OAuth. A feature-based role management system provides granular control over UI visibility and backend access, including protected system roles and role-based field access control.

## Deployment & Domain Structure
The application is deployed on Vercel, using `iconn.app` for tenant owner management and `{tenant}.iconn.app` for member portals, supported by cross-subdomain session cookies. A tenant resolver (`api/_lib/tenantResolver.js`) handles domain-to-tenant mapping and URL building.

## Key Features and Modules
-   **Core Data Model:** Includes Member, Organization, Role, and TeamMember entities.
-   **Content Management:** Event/booking management, general content management, dynamic page builder, custom forms with conditional logic, and blog posts.
-   **Communication:** Email template placeholder system and communication preferences.
-   **Workflow Automation:** Tenant-scoped workflows for automating actions like sending emails, updating fields, creating contracts, and creating memberships, including a Due Diligence process. The `create_membership` action uses the shared `simulateMembershipForOrg()` function from `membershipSimulation.js` for all cost calculations (both dry-run and live paths), eliminating duplicate logic. Before creating a record, the workflow action checks the org's invoicing mode for the target year (with legacy null `membership_year` fallback): if mode is 'manual' or 'scheduled', the action is skipped with a descriptive message; only 'automatic' mode (or no setting, which defaults to automatic) proceeds with record creation. The cron job (`process-membership-renewals.js`) also uses `simulateMembershipForOrg()` for all cost calculations, with safeguards: (1) orgs without a Go Live date are skipped, (2) duplicate records are prevented at both application level (existingRecord check) and DB constraint level (23505 handling), (3) year targeting respects the invoicing setting's `membership_year` with fallback to current year. Scheduled invoicing of existing records derives VAT from the stored record/band rather than current simulation. Manual renewal (`handleManualRenewal` in `org-membership-invoicing.js`) also uses `simulateMembershipForOrg()`, accepting `membershipYear` from the frontend (defaults to current year), with go-live date and duplicate guards. The "Renew & Invoice Now" button only appears on the current year section.
-   **Branding & Customization:** Per-tenant branding for public-facing pages and embeddable forms.
-   **Data Management:** Server-side pagination and a robust data migration system.
-   **Email Domain Provisioning:** Automated Mailgun domain provisioning for each tenant.
-   **Realtime Updates:** Supabase Realtime Subscriptions for frontend cache invalidation.
-   **Booking System:** Agent booking system with tenant-scoped meeting templates.
-   **Resource View Tracking:** Tracks unique views per user per resource, displaying counts on resource cards and providing detailed reports.
-   **Organisation Membership Tab:** Displays a rolling two-year cost preview (current year + next year) with unified `YearCostSection` layout showing full breakdown (tier, discounts, pro-rata, rollover) for each year. The backend endpoint (`org-membership.js`) uses `simulateMembershipForOrg()` as the single source of truth for all cost calculations via `mapSimResultToYearData()` helper, eliminating duplicate inline calculation logic. When a history record exists for the current year, recorded values from the DB are displayed instead. Each year has independent Override, Simulate, and Invoicing controls. Invoicing mode (Automatic/Scheduled/Manual) is per-year, stored in `organisation_membership_invoicing` with `membership_year` column (also stores `purchase_order_number`). Legacy rows (null `membership_year`) are used as fallback for both UI and simulation. For Year 1 with Automatic mode, the go-live date (set via workflow) triggers renewal. Overrides are year-specific (keyed by `membership_year` in `organisation_membership_override` table) with legacy null `membership_year` fallback. Record Fee button is in the current year section. Supports renewal overrides with audit trails integrated with Xero for invoice generation. Automated renewal cron job handles scheduled renewals. Backend consumers (`membershipSimulation.js`, `process-membership-renewals.js`) query overrides and invoicing settings by year with null fallback. PO numbers flow through all renewal paths to Xero invoice references. "Email Fees" button generates secure tokens and sends branded emails with cost breakdown and payment link to org finance contacts. Public member-facing page (`/membership-fees/:token`) shows tenant-branded fee breakdown with PO submission and Stripe payment support; payment auto-creates membership history and Xero invoice. Token system (`membership_fee_token` table) tracks status (pending/po_submitted/paid/expired/cancelled) with 30-day expiry. After Xero invoice creation, a branded notification email is automatically sent to the org's invoicing email (or primary contact fallback) with invoice details and a link to the Xero online invoice (`membershipInvoiceEmail.js`). The online invoice URL is fetched from Xero's `/OnlineInvoice` endpoint (available for non-DRAFT invoices). This email is wired into all three invoice creation paths: manual renewal, Stripe payment confirmation, and cron-based renewal. **Pending:** DB migration to change unique constraint from `(tenant_id, organization_id)` to `(tenant_id, organization_id, membership_year)` to allow multiple overrides per org.
-   **Fundraising Module:** Supports tenant-scoped fundraising campaigns with team members, unique donation pages, Stripe payment processing, and UK Gift Aid capture.
-   **Bookmarking System:** Allows members to bookmark various content types with drag-and-drop reordering for categories and items.
-   **Forum Module:** Provides tenant-scoped discussion forums with role-managed access, threaded discussions, reactions, content reporting, and a full moderation suite with audit logging. Soft deletion preserves reply tree structures.

## Event Timezone Handling
Event times are stored in UTC with a separate timezone field for display, prioritizing Zoom, then event-specific, then 'Europe/London'.

## Membership Tier System
The system supports membership pricing based on organization attributes with historical versioning and multi-structure support, allowing multiple active tier configurations simultaneously, optionally scoped to specific organization field values. A custom discount system allows configurable discounts based on organization custom field values, stacking multiple rules, and applying before pro-rata, free period, and rollover calculations. Pro-rata pricing logic includes free periods and rollover discounts, with go-live date determining the application of discounts across membership years. The tier management UI (`MembershipTierManagement.jsx`) uses a 6-step wizard: (1) Structure Scope, (2) Tier Model (tiered vs flat cost), (3) Period (fixed year vs immediate start), (4) Discounts, (5) Pricing, (6) Summary. New fields: `pricing_model` ('tiered'|'flat'), `start_mode` ('fixed_date'|'immediate'), `flat_cost` (for non-tiered pricing). The incentive system supports two types: "Free Period" (months/weeks/days of free membership) and "Percentage Discount" (X% off annual cost). Both types use the same DB columns (`free_period_amount` stores the value, `free_period_unit` stores 'months'/'weeks'/'days' or 'percent'). Percentage discounts are pro-rated in Year 1 based on remaining days (remainingDays/totalDays × fullDiscount), with the unused portion rolling over to Year 2 as a fixed amount deduction. Year 2 rollover derives Year 1 boundaries from the go-live date (not the current year) to ensure accurate calculations regardless of when simulation runs.

## UI/UX
The frontend utilizes a custom "new-york" design system, leveraging shadcn/ui (Radix UI) and Tailwind CSS for a consistent, responsive user experience with a collapsible sidebar.

# External Dependencies
-   **Supabase:** PostgreSQL database and file storage.
-   **Stripe:** Payment processing.
-   **Xero:** Invoice generation.
-   **Microsoft Graph API:** Outlook email integration.
-   **Mailgun:** Tenant-specific email sending, delivery, and native Email Marketing System (EMS).
-   **Zoho Campaigns:** Syncing member communication preferences.