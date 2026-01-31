# Overview

This project is a multi-tenant SaaS membership management platform providing organizations with a comprehensive solution for managing members, events, bookings, resources, and blog posts. It aims to consolidate various organizational management functions into a single, efficient platform, offering significant market potential. Key capabilities include a unified identity system, a dynamic page builder, custom forms, workflow automation, and a robust Due Diligence process. The platform supports a three-tier hierarchy (TENANT, ORGANIZATION, MEMBER) with strong access control and data isolation.

# User Preferences

Preferred communication style: Simple, everyday language.

# System Architecture

## Core Technologies
The frontend is built with React 18 (TypeScript/JSX), Vite, TanStack Query, shadcn/ui (Radix UI), and Tailwind CSS. The backend uses Express.js, PostgreSQL (Neon serverless), and Drizzle ORM. All API endpoints are deployed as Vercel serverless functions.

## Multi-Tenant Architecture
The platform is designed for multi-tenancy, ensuring data isolation across GLOBAL, TENANT, ORGANIZATION, and MEMBER levels, primarily using `tenant_id` and `organization_id` for scoping. Tenant-scoped tables, such as `organization`, `member`, `role`, `event`, `program`, `form`, `resource`, `job_posting`, `email_template`, and `workflow`, require proper tenant context for queries.

## API Authentication Pattern
The platform supports two types of authenticated sessions: Member sessions (portal users) and Tenant user sessions (admin dashboard users). `getTenantContext(req)` is the preferred function for handling both session types, returning `{ tenantId, memberId, isAuthenticated, ... }`. Admin-only endpoints should use `getSessionTenantUser(req)`, and member-only endpoints use `getSessionMember(req)`.

## Identity and Access Management
A unified identity system (`tenant_identity` table) manages user authentication, supporting multiple tenant ownership and organization memberships with per-tenant password isolation and Google OAuth. A feature-based role management system provides granular control over UI visibility and backend access, including protected system roles and role-based field access control.

## Deployment & Domain Structure
The application is deployed on Vercel, utilizing `iconn.app` for tenant owner management and `{tenant}.iconn.app` for member portals, enabled by cross-subdomain session cookies.

## Key Features and Modules
-   **Core Data Model:** Includes Member, Organization, Role, and TeamMember entities.
-   **Content Management:** Event/booking management, general content management, dynamic page builder, custom forms with conditional logic, and blog posts.
-   **Communication:** Email template placeholder system for dynamic emails and communication preferences management.
-   **Workflow Automation:** Tenant-scoped workflows for automating actions based on entity events, including a Due Diligence process.
-   **Branding & Customization:** Per-tenant branding system for public-facing pages, allowing customization of colors, logos, and page configurations.
-   **Form Embedding:** Forms can be embedded on external websites via iFrame with a public API.
-   **API Patterns:** Public API endpoints for unauthenticated access and authenticated endpoints using `getTenantContext(req)`.
-   **Data Management:** Server-side pagination and a robust data migration system.
-   **Email Domain Provisioning:** Automated Mailgun domain provisioning for each tenant.
-   **Realtime Updates:** Supabase Realtime Subscriptions for frontend cache invalidation.
-   **Booking System:** Agent booking system with tenant-scoped meeting templates.

## UI/UX
The frontend utilizes a custom "new-york" design system, leveraging shadcn/ui (Radix UI) and Tailwind CSS for a consistent and responsive user experience, including a collapsible sidebar.

# External Dependencies

-   **Supabase:** Primary database (PostgreSQL) and file storage.
-   **Stripe:** Payment processing.
-   **Xero:** Invoice generation.
-   **Microsoft Graph API:** Outlook email integration.
-   **Mailgun:** Tenant-specific email sending domains, email delivery, and a native Email Marketing System (EMS) with full tracking capabilities (campaign management, audience targeting, recipient filtering, link/open tracking, bounce handling, unsubscribe management, click heatmap, analytics).
-   **Zoho Campaigns:** Integrations for syncing member communication preferences, supporting multi-tenant deployments with encrypted credentials and background sync jobs.