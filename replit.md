# Overview

This project is a multi-tenant SaaS membership management platform for organizations to manage members, events, bookings, resources, and blog posts. It provides comprehensive administrative functions and integrates with external services for CRM, payments, and accounting, aiming to be an all-in-one solution for various organizational needs. The platform supports a three-tier hierarchy: TENANT, ORGANIZATION, and MEMBER, with robust access control and data isolation. Key capabilities include a unified identity system, dynamic page builder, custom forms, workflow automation, and a comprehensive Due Diligence process flow.

# User Preferences

Preferred communication style: Simple, everyday language.

# System Architecture

## Frontend

The frontend uses React 18 with TypeScript/JSX, Vite, TanStack Query, shadcn/ui (Radix UI), and Tailwind CSS. It features client-side routing and a customized "new-york" shadcn/ui design system.

## Backend

The backend is built with Express.js, using PostgreSQL (Neon serverless) with Drizzle ORM. It follows a generic entity CRUD API pattern, incorporates password-based authentication, server-side session management, and an admin security model with role-based access control. All API endpoints are implemented as Vercel serverless functions.

## Multi-Tenant SaaS Architecture

The platform enforces data isolation at GLOBAL, TENANT, ORGANIZATION, and MEMBER levels, with all application data primarily scoped to `tenant_id`. `organization_id` is used for sub-filtering within a tenant.

## Unified Identity System

A centralized `tenant_identity` table handles user authentication for owners and members, supporting multiple tenant ownership and organization memberships. Per-tenant password isolation is implemented via `tenant_membership_credentials`. Both systems support Google OAuth.

## Deployment & Domain Architecture

The application is deployed on Vercel. The domain structure uses `iconn.app` for tenant owner management and `{tenant}.iconn.app` for member portals, with session cookies enabling cross-subdomain sharing.

## Data Model & Features

The data model includes core entities like Member, Organization, Role, and TeamMember, supporting role segmentation, event/booking management, content management, a dynamic page builder, custom forms with conditional logic, workflows, Speaker profiles, Card Deck content, navigation/settings, communication preferences, custom fields, training funds, voucher codes, and internal notes.

## Role Management System

A feature-based role management system controls UI visibility and backend access, including protected system roles and role-based field access control for member profiles.

## Email Template Placeholder System

The platform supports dynamic email templates with placeholder substitution for form submissions, allowing multiple emails per submission with system and custom placeholders.

## Due Diligence Process Flow

The Due Diligence (DD) system provides a comprehensive workflow for reviewing form submissions, scoring applicants, sending contracts for signature, and handling contract timeouts with alternative signer capabilities. This includes user-created DD application forms and contract template forms with configurable stages, actions (Send Email, Create Contract, Send Meeting Request), and a contract signing flow with timeout detection and an alternative signer mechanism using a round-based token system for security.

## Platform Owner Configuration System

A third authentication tier for "Platform Owners" provides super-admin capabilities for managing platform-wide preferences and tenant deletion.

## Tenant Branding System

The platform supports per-tenant branding customization for public-facing pages, storing `primary_color`, `secondary_color`, `tagline`, `logo_url`, `header_config`, and `footer_config` as JSONB. A public API endpoint returns branding based on subdomain detection.

## Form Embedding System

Forms can be embedded on external websites via iFrame, with a public API endpoint providing form data and an embed page for rendering.

## Public API Client

All public-facing pages use a centralized `publicClient` for tenant-aware API requests, ensuring multi-tenant data isolation for unauthenticated users.

## Session Validation Security Pattern

Hybrid pages use a `sessionValidated` flag to prevent leaking member-only data to unauthenticated users with stale localStorage, ensuring authenticated API calls only occur after session validation.

## Tenant Email Domain Provisioning System

The platform supports automated Mailgun domain provisioning for each tenant, enabling tenant-specific email sending domains with Vercel DNS record creation.

## Collapsible Sidebar Implementation

The authenticated portal uses Shadcn's collapsible sidebar component with ref-forwarding for navigation links, tooltips for collapsed icons, and adaptive footer content.

## Cross-Organization Access Control (CRM)

Access to organization-scoped data for write operations is controlled by role permissions. Members with `admin.organizations` or `admin.role-management` permissions can edit data for any organization within their tenant; regular members are restricted to their own organization's data.

## Workflow Automation System

Workflows are tenant-scoped entities that enable automated actions based on entity events (organization, member, job_posting). Queries filter by `tenant_id` for multi-tenant isolation. Field change triggers can optionally require user confirmation.

## Supabase Realtime Subscriptions

The frontend uses Supabase Realtime to subscribe to database changes and automatically refresh lists when data is modified. A `useRealtimeSubscription` hook provides tenant-scoped subscriptions that invalidate TanStack Query cache keys for INSERT/UPDATE/DELETE events.

## Contract Signing Module

This system, built on the FormBuilder infrastructure, allows structured forms with signature fields to be sent for electronic signatures. It differentiates between contract templates (forms with contract settings) and contract instances (individual contracts linked to organizations and signers with status tracking). Features include a signature field type, workflow integration, multi-signer support, and automated reminders.

## Agent Booking System with Meeting Templates

The platform includes a booking system where team members can be designated as "booking agents" with personal booking pages. It features tenant-scoped meeting templates, agent-template assignments, and database tables for managing templates, agent availability, and bookings. Meeting invitations can be sent as stage actions within due diligence workflows.

# External Dependencies

- **Supabase:** Primary database (PostgreSQL) and file storage.
- **Stripe:** Payment processing.
- **Xero:** Invoice generation.
- **Microsoft Graph API:** Outlook email integration.
- **Mailgun:** Tenant-specific email sending domains and email delivery.