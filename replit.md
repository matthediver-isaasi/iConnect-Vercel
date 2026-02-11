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
-   **Workflow Automation:** Tenant-scoped workflows for automating actions like sending emails, updating fields, creating contracts, and creating memberships, including a Due Diligence process. The `create_membership` action incorporates go_live-aware discount logic.
-   **Branding & Customization:** Per-tenant branding for public-facing pages and embeddable forms.
-   **Data Management:** Server-side pagination and a robust data migration system.
-   **Email Domain Provisioning:** Automated Mailgun domain provisioning for each tenant.
-   **Realtime Updates:** Supabase Realtime Subscriptions for frontend cache invalidation.
-   **Booking System:** Agent booking system with tenant-scoped meeting templates.
-   **Resource View Tracking:** Tracks unique views per user per resource, displaying counts on resource cards and providing detailed reports.
-   **Organisation Membership Tab:** Displays per-organization membership tiers, allows editing control variables, previews next year's fees with rollover discounts, and records historical fees. Supports renewal overrides with audit trails and multiple invoicing options (Automatic/Scheduled/Manual) integrated with Xero for invoice generation. Automated renewal cron job handles scheduled renewals.
-   **Fundraising Module:** Supports tenant-scoped fundraising campaigns with team members, unique donation pages, Stripe payment processing, and UK Gift Aid capture.
-   **Bookmarking System:** Allows members to bookmark various content types with drag-and-drop reordering for categories and items.
-   **Forum Module:** Provides tenant-scoped discussion forums with role-managed access, threaded discussions, reactions, content reporting, and a full moderation suite with audit logging. Soft deletion preserves reply tree structures.

## Event Timezone Handling
Event times are stored in UTC with a separate timezone field for display, prioritizing Zoom, then event-specific, then 'Europe/London'.

## Membership Tier System
The system supports membership pricing based on organization attributes with historical versioning and multi-structure support, allowing multiple active tier configurations simultaneously, optionally scoped to specific organization field values. A custom discount system allows configurable discounts based on organization custom field values, stacking multiple rules, and applying before pro-rata, free period, and rollover calculations. Pro-rata pricing logic includes free periods and rollover discounts, with go-live date determining the application of discounts across membership years. The tier management UI (`MembershipTierManagement.jsx`) uses a 6-step wizard: (1) Structure Scope, (2) Tier Model (tiered vs flat cost), (3) Period (fixed year vs immediate start), (4) Discounts, (5) Pricing, (6) Summary. New fields: `pricing_model` ('tiered'|'flat'), `start_mode` ('fixed_date'|'immediate'), `flat_cost` (for non-tiered pricing).

## UI/UX
The frontend utilizes a custom "new-york" design system, leveraging shadcn/ui (Radix UI) and Tailwind CSS for a consistent, responsive user experience with a collapsible sidebar.

# External Dependencies
-   **Supabase:** PostgreSQL database and file storage.
-   **Stripe:** Payment processing.
-   **Xero:** Invoice generation.
-   **Microsoft Graph API:** Outlook email integration.
-   **Mailgun:** Tenant-specific email sending, delivery, and native Email Marketing System (EMS).
-   **Zoho Campaigns:** Syncing member communication preferences.