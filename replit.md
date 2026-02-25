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
-   **Content Management:** Event/booking management, general content management, dynamic page builder (with timeline element supporting up to 5 images per date in a carousel via `media_items` array with backward compat for legacy single `media` field), custom forms with conditional logic, and blog posts.
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
Supports membership pricing based on organization attributes with historical versioning, multi-structure support, and configurable discounts. Includes pro-rata pricing logic, free periods, and rollover discounts, with a go-live date determining discount application. The tier management UI uses a 6-step wizard for configuration.

## UI/UX
The frontend utilizes a custom "new-york" design system, leveraging shadcn/ui (Radix UI) and Tailwind CSS for a consistent, responsive user experience with a collapsible sidebar.

# External Dependencies
-   **Supabase:** PostgreSQL database and file storage.
-   **Stripe:** Payment processing.
-   **Xero:** Invoice generation.
-   **Microsoft Graph API:** Outlook email integration.
-   **Mailgun:** Tenant-specific email sending, delivery, and native Email Marketing System (EMS).
-   **Zoho Campaigns:** Syncing member communication preferences.