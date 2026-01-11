# Overview

This project is a comprehensive membership management platform built with React (Vite) and Express.js, aiming for 100% visual and functional parity with its predecessor (Base44). It manages members, organizations, events, bookings, program tickets, resources, and blog posts, along with administrative functions. The platform's core purpose is to streamline membership operations, event management, and content delivery for organizations, integrating with various external services for CRM, payments, and accounting to provide a robust, all-in-one solution. It is designed as a multi-tenant SaaS product with ambitious market potential to serve a wide range of organizations.

# User Preferences

Preferred communication style: Simple, everyday language.

# System Architecture

## Frontend Architecture

The frontend uses React 18 with TypeScript/JSX, Vite, TanStack Query, shadcn/ui (Radix UI), and Tailwind CSS. It implements client-side routing and a customized "new-york" shadcn/ui design system for visual consistency.

## Backend Architecture

The backend is built with Express.js and uses PostgreSQL (Neon serverless) with Drizzle ORM. It follows a generic entity CRUD API pattern, with password-based authentication and server-side session management. An admin security model implements role-based access control, and server-side functions handle specific operations like magic links, Stripe payments, bookings, and event synchronization. All API endpoints are implemented as Vercel serverless functions.

## Multi-Tenant SaaS Architecture

The platform supports a three-tier hierarchy: TENANT, ORGANIZATION, and MEMBER. A `tenant` table stores SaaS subscribing companies, and access control enforces data isolation at GLOBAL, TENANT, ORGANIZATION, and MEMBER levels, ensuring records are scoped to the authenticated user's context.

## Unified Identity System

The platform uses a centralized `tenant_identity` table for ALL user authentication (owners and members). This enables:
- A single user (by email) to own multiple tenants AND be a member in multiple organizations
- Seamless tenant switching between owned and member tenants
- Centralized password management across all tenant relationships

The `tenant_membership` table tracks user relationships to tenants with:
- `identity_id`: Links to the user's central identity
- `membership_type`: Either 'owner' (admin access) or 'member' (portal access)
- `member_id`: Optional link to a member record for portal functionality
- Session types are determined by membership_type: `tenant_user` for owners, `member` for portal users

Legacy `member_credentials` are migrated to `tenant_identity` for unified authentication. The migration script is at `scripts/migrations/unify-user-identity.sql`.

Both systems support Google OAuth for authentication, with a centralized callback pattern for member OAuth and per-tenant control over Google login availability.

## Deployment Architecture

Development uses Express.js with Vite middleware. Production deploys to Vercel serverless functions for API and static assets. Data freshness is maintained using TanStack Query and Supabase Realtime Subscriptions. Immediate session invalidation is enforced based on member status changes.

## Data Model & Features

The data model encompasses core entities like Member, Organization, Role, TeamMember, supporting role segmentation, event/booking management, content management (BlogPost, Resource), and a dynamic page builder. Additional features include a custom forms system with conditional logic and entity pipelines, workflows for automation, Speaker profiles, Card Deck content, navigation/settings configuration, communication preferences, custom fields, training funds, voucher codes, and an internal notes system for organizations and members.

## Role Management System

A feature-based role management system controls UI visibility and backend access. System roles are protected from modification or deletion via database triggers, API guards, and UI controls. Role-based field access control for member profile fields is also implemented.

## Email Template Placeholder System

The platform supports dynamic email templates with placeholder substitution for form submissions, allowing for multiple emails per submission with system and custom placeholders.

## Form Due Diligence Extension System

An optional due diligence review capability for form submissions includes configurable workflows, scoring, risk assessment, and audit trails. It supports both dynamic and static traffic light scoring approaches with configurable workflow stages and status webhooks.

## Platform Owner Configuration System

A third authentication tier for "Platform Owners" provides super-admin capabilities across the entire SaaS platform. Platform owners manage platform-wide preferences, including default role and navigation templates for new tenant provisioning, and can perform tenant deletion with built-in safety mechanisms.

# External Dependencies

**Supabase:** Primary database (PostgreSQL) for application data, including CRUD and realtime subscriptions, and file storage.
**Stripe:** Payment processing.
**Xero:** Invoice generation with multi-tenant isolation.
**Email Delivery:** For magic links and notifications.