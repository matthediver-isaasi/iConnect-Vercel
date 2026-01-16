# Overview

This project is a comprehensive membership management platform built with React (Vite) and Express.js. It aims to streamline membership operations, event management, and content delivery for organizations. Key capabilities include managing members, organizations, events, bookings, program tickets, resources, and blog posts, alongside administrative functions. It integrates with various external services for CRM, payments, and accounting, providing a robust, all-in-one solution designed as a multi-tenant SaaS product.

# User Preferences

Preferred communication style: Simple, everyday language.

# System Architecture

## Frontend

The frontend uses React 18 with TypeScript/JSX, Vite, TanStack Query, shadcn/ui (Radix UI), and Tailwind CSS. It features client-side routing and a customized "new-york" shadcn/ui design system.

## Backend

The backend is built with Express.js, using PostgreSQL (Neon serverless) with Drizzle ORM. It follows a generic entity CRUD API pattern, incorporating password-based authentication and server-side session management. An admin security model implements role-based access control. All API endpoints are implemented as Vercel serverless functions.

## Multi-Tenant SaaS Architecture

The platform supports a three-tier hierarchy: TENANT, ORGANIZATION, and MEMBER. A `tenant` table stores SaaS subscribing companies, and access control enforces data isolation at GLOBAL, TENANT, ORGANIZATION, and MEMBER levels. Members are TENANT-scoped, allowing individuals to exist without belonging to an organization.

## Unified Identity System

A centralized `tenant_identity` table handles all user authentication for owners and members. This allows a single user to own multiple tenants and be a member in multiple organizations, facilitating seamless tenant switching. Per-tenant password isolation is implemented via `tenant_membership_credentials`, allowing different passwords for each tenant an identity belongs to. Both systems support Google OAuth.

## Deployment

**CRITICAL: IGNORE the local Express dev server entirely.** All development, testing, and debugging happens on Vercel preview branches. The Replit workspace is used only for code editing - never for running or testing the application locally.

- All code changes automatically deploy to Vercel preview branches
- There is NO separate development environment or database
- The Replit workspace connects to the same Supabase production database as Vercel
- API endpoints are Vercel serverless functions in the `/api/` directory
- Test all changes on the Vercel preview URL, not locally
- Debug using Vercel logs, not local Express logs

## Data Model & Features

The data model includes core entities like Member, Organization, Role, TeamMember, supporting role segmentation, event/booking management, content management (BlogPost, Resource), and a dynamic page builder. Additional features encompass a custom forms system with conditional logic, workflows, Speaker profiles, Card Deck content, navigation/settings configuration, communication preferences, custom fields, training funds, voucher codes, and an internal notes system.

## Role Management System

A feature-based role management system controls UI visibility and backend access, with protected system roles and role-based field access control for member profiles.

## Email Template Placeholder System

The platform supports dynamic email templates with placeholder substitution for form submissions, allowing multiple emails per submission with system and custom placeholders.

## Form Due Diligence Extension System

An optional due diligence review capability for form submissions includes configurable workflows, scoring, risk assessment, and audit trails.

## Platform Owner Configuration System

A third authentication tier for "Platform Owners" provides super-admin capabilities, managing platform-wide preferences and performing tenant deletion.

## Tenant Branding System

The platform supports per-tenant branding customization for public-facing pages, including `primary_color`, `secondary_color`, `tagline`, `logo_url`, `header_config`, and `footer_config` stored as JSONB. A public API endpoint (`/api/public/tenant-branding`) returns branding based on subdomain detection, integrated via `TenantBrandingContext` in the frontend.

## Form Embedding System

Forms can be embedded on external websites via iFrame. A public API endpoint (`/api/public/form/[slug]`) provides form data, and an embed page (`/embed/form/:slug`) renders standalone forms. Security measures include tenant scoping, public-safe field returns, and disallowing embedding for forms requiring authentication.

## Public API Client

All public-facing pages use a centralized `publicClient` for tenant-aware API requests, ensuring multi-tenant data isolation for unauthenticated users. Tenant detection prioritizes URL query parameters, then localStorage, subdomain extraction, and finally an environment variable.

## Session Validation Security Pattern

Hybrid pages use a `sessionValidated` flag in `LayoutContext` to prevent leaking member-only data to unauthenticated users with stale localStorage. This flag is set to `true` only after successful `/api/auth/me` validation, ensuring authenticated API calls are made only when a valid session is confirmed.

## Outlook Email Integration

The platform supports Microsoft Outlook integration for email tracking on member records. This involves `outlook_connection` and `member_email` tables for OAuth tokens and synced emails, respectively. It includes OAuth flow, API endpoints for connection status, syncing, sending emails, and UI components for management.

# External Dependencies

**Supabase:** Primary database (PostgreSQL) for application data, including CRUD and realtime subscriptions, and file storage.
**Stripe:** Payment processing.
**Xero:** Invoice generation with multi-tenant isolation.
**Microsoft Graph API:** Outlook email integration for CRM-style email tracking on member records.
**Email Delivery:** For magic links and notifications.