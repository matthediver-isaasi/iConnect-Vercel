# Overview

This project is a multi-tenant SaaS membership management platform built with React (Vite) and Express.js. It offers comprehensive features for managing members, organizations, events, bookings, program tickets, resources, and blog posts. The platform also includes robust administrative functions and integrates with external services for CRM, payments, and accounting, aiming to be an all-in-one solution for organizations.

# User Preferences

Preferred communication style: Simple, everyday language.

# System Architecture

## Frontend

The frontend uses React 18 with TypeScript/JSX, Vite, TanStack Query, shadcn/ui (Radix UI), and Tailwind CSS. It features client-side routing and a customized "new-york" shadcn/ui design system.

## Backend

The backend is built with Express.js, using PostgreSQL (Neon serverless) with Drizzle ORM. It follows a generic entity CRUD API pattern, incorporates password-based authentication and server-side session management, and uses an admin security model with role-based access control. All API endpoints are implemented as Vercel serverless functions.

## Multi-Tenant SaaS Architecture

The platform supports a three-tier hierarchy: TENANT, ORGANIZATION, and MEMBER. A `tenant` table stores SaaS subscribing companies, and access control enforces data isolation at GLOBAL, TENANT, ORGANIZATION, and MEMBER levels. All application data, except platform-level (GLOBAL scope), **MUST be scoped to `tenant_id`**. `organization_id` is for sub-filtering within a tenant only, not primary isolation.

## Unified Identity System

A centralized `tenant_identity` table handles all user authentication for owners and members, allowing users to own multiple tenants and be members in multiple organizations. Per-tenant password isolation is implemented via `tenant_membership_credentials`. Both systems support Google OAuth.

## Deployment & Domain Architecture

All development, testing, and debugging occur on Vercel; the Replit workspace is for code editing only.
The domain structure uses `iconn.app` for tenant owner management and `{tenant}.iconn.app` for member portals. Session cookies use `.iconn.app` for cross-subdomain sharing. Preview and production environments function identically, with differences only in Vercel branch deployments and environment variables, not in code logic.

## Data Model & Features

The data model includes core entities like Member, Organization, Role, and TeamMember, supporting various functionalities such as role segmentation, event/booking management, content management (BlogPost, Resource), and a dynamic page builder. Additional features include a custom forms system with conditional logic, workflows, Speaker profiles, Card Deck content, navigation/settings configuration, communication preferences, custom fields, training funds, voucher codes, and an internal notes system.

## Role Management System

A feature-based role management system controls UI visibility and backend access, including protected system roles and role-based field access control for member profiles.

## Email Template Placeholder System

The platform supports dynamic email templates with placeholder substitution for form submissions, allowing multiple emails per submission with system and custom placeholders.

## Form Due Diligence Extension System

An optional due diligence review capability for form submissions includes configurable workflows, scoring, risk assessment, and audit trails.

## Platform Owner Configuration System

A third authentication tier for "Platform Owners" provides super-admin capabilities for managing platform-wide preferences and tenant deletion.

## Tenant Branding System

The platform supports per-tenant branding customization for public-facing pages, storing `primary_color`, `secondary_color`, `tagline`, `logo_url`, `header_config`, and `footer_config` as JSONB. A public API endpoint (`/api/public/tenant-branding`) returns branding based on subdomain detection.

## Form Embedding System

Forms can be embedded on external websites via iFrame, with a public API endpoint (`/api/public/form/[slug]`) providing form data and an embed page (`/embed/form/:slug`) for rendering. Security ensures tenant scoping and public-safe field returns.

## Public API Client

All public-facing pages use a centralized `publicClient` for tenant-aware API requests, ensuring multi-tenant data isolation for unauthenticated users.

## Session Validation Security Pattern

Hybrid pages use a `sessionValidated` flag in `LayoutContext` to prevent leaking member-only data to unauthenticated users with stale localStorage, ensuring authenticated API calls only occur after session validation.

## Outlook Email Integration

The platform supports Microsoft Outlook integration for email tracking on member records, involving OAuth for `outlook_connection` and `member_email` tables for syncing emails.

## Tenant Email Domain Provisioning System

The platform supports automated Mailgun domain provisioning for each tenant, enabling tenant-specific email sending domains (`mail.{tenant-slug}.iconn.app`) with Vercel DNS record creation.

## Collapsible Sidebar Implementation

The authenticated portal uses Shadcn's collapsible sidebar component with ref-forwarding for navigation links, tooltips for collapsed icons, and adaptive footer content.

## Cross-Organization Access Control (CRM)

Access to organization-scoped data for write operations is controlled purely by role permissions. Members with `admin.organizations` or `admin.role-management` permissions can edit data for any organization within their tenant, while regular members are restricted to their own organization's data.

## Workflow Automation System

Workflows are tenant-scoped entities that enable automated actions based on entity events (organization, member, job_posting). They include `tenant_id` for multi-tenant isolation, and queries filter by `tenant_id` to prevent cross-tenant execution.

# External Dependencies

**Supabase:** Primary database (PostgreSQL) and file storage.
**Stripe:** Payment processing.
**Xero:** Invoice generation.
**Microsoft Graph API:** Outlook email integration.
**Mailgun:** Tenant-specific email sending domains and email delivery.