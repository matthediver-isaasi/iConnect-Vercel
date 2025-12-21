# Overview

This project is a comprehensive membership management platform built with React (Vite) and Express.js. It facilitates the management of members, organizations, events, bookings, program tickets, resources, and blog posts, alongside essential administrative functions. The platform aims for 100% visual and functional parity with its predecessor (Base44) while leveraging modern technologies. Its core purpose is to streamline membership operations, event management, and content delivery for organizations, integrating with various external services for CRM, payments, and accounting to provide a robust, all-in-one solution.

# User Preferences

Preferred communication style: Simple, everyday language.

# System Architecture

## Frontend Architecture

The frontend uses React 18 with TypeScript/JSX, Vite, TanStack Query, shadcn/ui (Radix UI), and Tailwind CSS for styling. It implements client-side routing and a customized "new-york" shadcn/ui design system for visual parity.

## Backend Architecture

The backend is built with Express.js and uses PostgreSQL (Neon serverless) with Drizzle ORM. It follows a generic entity CRUD API pattern, with password-based authentication and server-side session management. An admin security model implements role-based access control. Server-side functions handle specific operations like magic links, Stripe payments, bookings, and event synchronization.

## Data Model

The data model includes core entities like Member, Organization, Role, TeamMember, supporting role segmentation, event/booking management (Zoho Backstage synced and one-off events, guest checkout), content management (BlogPost, Resource), and a dynamic page builder. A custom forms system supports various layouts and advanced uniqueness validation. Workflows provide automation rules triggered by field changes or record creation/updates. Additional features include Speaker profiles, Card Deck content, navigation/settings configuration, communication preferences, custom fields, training funds, and voucher codes.

## Deployment Architecture

Development uses Express.js with Vite middleware. Production deploys to Vercel serverless functions for API and static assets. Data sync from Zoho CRM is one-way, triggered by member login or admin actions. Data freshness is maintained using TanStack Query and Supabase Realtime Subscriptions.

## Runtime Page Provisioning (CMS Feature)

The platform includes a CMS feature for administrators to create and manage dynamic pages and routes at runtime using a `/:slug` catch-all route, with support for draft/published statuses and public/member access controls.

## My Organisation Page

A dedicated `/myorganisation` page displays organization details and custom fields, with access controlled via Role Management.

## Organisations CRM List (/organisations)

An admin-only CRM-style page for managing organizations, featuring search, filters, various views, pagination, and detailed profiles. Access is controlled by feature exclusions.

## Role Management System

The role management system uses a hierarchical Module→Page→Feature structure to control visibility. Roles store `excluded_features` arrays. Dynamic configuration of this hierarchy is managed via an Admin UI, storing data in a `role_access_item` Supabase table.

**Admin Status Fully Deprecated (Dec 2025):** The binary `is_admin` concept has been completely removed from the application. Access control is now 100% feature-based using the `excluded_features` array:

- **Backend endpoints** check specific feature exclusions relevant to their function (e.g., data export checks `admin.data-export`, job postings check `admin.job-postings`)
- **UI components** no longer display admin badges - roles are shown without special admin indicators
- **Admin navigation visibility** is determined purely by feature exclusions - if any admin menu items remain after filtering, the admin section shows. No separate `hasAdminNavAccess()` gate exists.
- **LayoutContext** no longer exposes `isAdmin` state - only `isFeatureExcluded()` is available
- **RoleManagement** no longer persists the `is_admin` field when saving roles
- **useMemberAccess hook** still exports `isAdmin` for backward compatibility - computed locally from role's excluded_features (not from context)
- **Feature exclusion examples**: `admin.data-export`, `admin.member-handles`, `admin.program-tickets`, `admin.programs`, `admin.events`, `admin.job-postings`

All access control throughout the application now uses `isFeatureExcluded()` from the `useMemberAccess` hook.

**Public Role for Non-Logged-In Visitors (Dec 2025):** A special "Public" system role controls what non-authenticated visitors can see and access:

- **System Role Protection**: The "Public" role cannot be deleted or renamed in RoleManagement (identified by name, shown with "System Role" badge)
- **Public Role Loading**: Both `useMemberAccess` hook and `Layout.jsx` load the Public role when `memberInfo === null`
- **Feature Exclusions Apply**: The `isFeatureExcluded()` function uses Public role's `excluded_features` for non-logged-in users
- **Configuration**: Admins configure Public role's exclusions via RoleAccessConfigManagement, same as any other role
- **Navigation Filtering**: Public pages/navigation items are filtered based on Public role exclusions
- **Fallback Behavior**: If Public role doesn't exist or has no exclusions, non-logged-in users have no restrictions (backward compatible)

## Email Template Placeholder System

The platform supports dynamic email templates with placeholder substitution for form submissions. Forms can send multiple emails per submission with independent configurations, allowing for system and custom placeholders mapped to form fields. The backend handles placeholder replacement and supports backward compatibility with legacy single email fields.

## Entity Pipelines System

Forms use a unified `entity_pipelines` system to configure member and organization record creation/updates on form submission. This system uses a `mappings` array for each entity entry, supporting transformations and both field-based and static value sources. The UI is integrated into the FormBuilder, and processing logic handles primary and additional entity UPSERTs, deduplication, and field clearing using a `__clear__` sentinel value. It maintains backward compatibility with legacy form fields.

## Form Conditional Logic Visibility System

Forms support conditional visibility rules that control the visibility and enabled state of fields based on other field values. Rules specify `visible` and `enabled` states (true/false/null) for target fields.

# External Dependencies

**Supabase:** Primary database (PostgreSQL) for application data, including CRUD and realtime subscriptions, and file storage.
**Zoho CRM:** Contact and account synchronization.
**Zoho Backstage:** Event management and ticket sales integration.
**Stripe:** Payment processing.
**Xero:** Invoice generation.
**Email Delivery:** For magic links and notifications.