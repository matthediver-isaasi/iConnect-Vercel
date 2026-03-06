# Overview
This project is a multi-tenant SaaS platform for comprehensive membership management, unifying member, event, booking, resource, and blog post management. It features a unified identity system, dynamic page builder, custom forms with workflow automation, and a robust Due Diligence process. The platform supports a three-tier hierarchy (TENANT, ORGANIZATION, MEMBER) for access control and data isolation, aiming to streamline operations for organizations.

# User Preferences
Preferred communication style: Simple, everyday language.

# System Architecture
The frontend is built with React 18 (TypeScript/JSX), Vite, TanStack Query, shadcn/ui (Radix UI), and Tailwind CSS. The backend uses Express.js, PostgreSQL, and Drizzle ORM, with API endpoints deployed as Vercel serverless functions.

## Multi-Tenant Architecture
Data isolation is enforced across GLOBAL, TENANT, ORGANIZATION, and MEMBER levels using `tenant_id` and `organization_id`. API authentication supports both Member (portal) and Tenant user (admin dashboard) sessions.

## Identity and Access Management
A unified identity system manages user authentication, multi-tenant ownership, and organization memberships. It includes per-tenant password isolation, Google OAuth, and feature-based role management for granular control over UI visibility, backend access, and field access.

## Deployment & Domain Structure
The application is deployed on Vercel, using `iconn.app` for tenant owner management and `{tenant}.iconn.app` for member portals, with a tenant resolver for domain-to-tenant mapping.

## Key Features
-   **Core Data Model:** Includes Member, Organization, Role, and TeamMember entities.
-   **Content Management:** Features event/booking management, general content management, a dynamic page builder with advanced timeline elements, custom forms with conditional logic and uniqueness validation, and blog posts.
-   **Membership Payment:** Integrates Stripe for membership fees, supporting auto-submission, year 2 rollover logic, Xero invoice attachment, and configurable invoice address sourcing.
-   **Communication:** Includes an email template system, communication preferences, and email campaigns with list-based targeting.
-   **Workflow Automation:** Provides tenant-scoped workflows for automating actions like sending emails, updating fields, and managing memberships.
-   **Field Visibility Rules:** Implements conditional show/hide rules for fields and cards on organisation and member detail views, with role-based read/write control and drag-and-drop reordering.
-   **Branding & Customization:** Supports per-tenant branding for public-facing pages and embeddable forms.
-   **Fundraising Module:** Supports tenant-scoped campaigns with donation pages, Stripe processing, UK Gift Aid, and AI-suggested content.
-   **Dynamic Directory:** Configurable member/organisation directories with slug-based URLs, server-side filtering, and field visibility settings.
-   **Forum Module:** Provides tenant-scoped discussion forums with role-managed access.
-   **Membership Tier System:** Supports pricing based on organization or member attributes with historical versioning, multi-structure support, configurable discounts, pro-rata pricing, and cron-based renewals.

## UI/UX
The frontend employs a custom "new-york" design system, leveraging shadcn/ui (Radix UI) and Tailwind CSS for a consistent, responsive user experience with a collapsible sidebar.

# External Dependencies
-   **Supabase:** PostgreSQL database and file storage.
-   **Stripe:** Payment processing, supporting per-feature test/live mode switching.
-   **Xero:** Invoice generation.
-   **Microsoft Graph API:** Outlook email integration.
-   **Mailgun:** Tenant-specific email sending, delivery, and native Email Marketing System (EMS).
-   **Zoho Campaigns:** Syncing member communication preferences.

## Organisation Directory Type Filter
Organisation Directory Settings (`OrganisationDirectorySettings.jsx`) supports a "Visible Organisation Types" filter via the `org_directory_visible_org_types` system setting (JSON array of type values). When non-empty, only organisations whose `org_type`/`organisation_type`/`organization_type` preference field value matches one of the selected types are shown. Empty = show all (backward compatible). Both `OrganisationDirectory.jsx` and `IEditOrganisationDirectoryElement.jsx` (page builder) respect this filter. The settings and directory pages use separate TanStack Query keys (`organisation-directory-settings-admin` vs `organisation-directory-settings`) to avoid cache collisions.