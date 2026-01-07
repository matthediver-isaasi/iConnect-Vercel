# Overview

This project is a comprehensive membership management platform built with React (Vite) and Express.js. It facilitates the management of members, organizations, events, bookings, program tickets, resources, and blog posts, alongside essential administrative functions. The platform aims for 100% visual and functional parity with its predecessor (Base44) while leveraging modern technologies. Its core purpose is to streamline membership operations, event management, and content delivery for organizations, integrating with various external services for CRM, payments, and accounting to provide a robust, all-in-one solution.

# User Preferences

Preferred communication style: Simple, everyday language.

# Development Guidelines

## API Development (IMPORTANT)

**All API endpoints MUST be implemented as Vercel serverless functions in the `/api/` directory.**

- NEVER create or recreate `server/routes.ts` - this file was deprecated and deleted in January 2026
- Use the existing patterns in `api/_lib/database.js` for database access
- Use `api/_lib/session.js` for session management
- Follow the existing file structure:
  - `api/entities/[entity]/index.js` - For entity CRUD operations
  - `api/entities/[entity]/[id].js` - For single entity operations
  - `api/functions/[functionName].js` - For server-side functions
- The Express server (`server/app.ts`) only serves the frontend and routes `/api/*` to Vercel handlers via `server/vercel-api-adapter.ts`

# System Architecture

## Frontend Architecture

The frontend uses React 18 with TypeScript/JSX, Vite, TanStack Query, shadcn/ui (Radix UI), and Tailwind CSS for styling. It implements client-side routing and a customized "new-york" shadcn/ui design system for visual parity.

## Backend Architecture

The backend is built with Express.js and uses PostgreSQL (Neon serverless) with Drizzle ORM. It follows a generic entity CRUD API pattern, with password-based authentication and server-side session management. An admin security model implements role-based access control. Server-side functions handle specific operations like magic links, Stripe payments, bookings, and event synchronization.

## Session Security (Dec 2025)

Immediate session invalidation is enforced when:
- A member's `login_enabled` is set to false
- A member is deleted (anonymized)
- An organization is deleted (all its members are immediately logged out)

The `getSessionMember()` function validates `login_enabled` status on every authenticated request. If disabled or deleted, the session is immediately destroyed and the request is rejected. The `invalidateMemberSessions()` helper function is called proactively during admin actions to ensure all active sessions are removed before changes take effect.

## Data Model

The data model includes core entities like Member, Organization, Role, TeamMember, supporting role segmentation, event/booking management (Zoho Backstage synced and one-off events, guest checkout), content management (BlogPost, Resource), and a dynamic page builder. A custom forms system supports various layouts and advanced uniqueness validation. Workflows provide automation rules triggered by field changes or record creation/updates. Additional features include Speaker profiles, Card Deck content, navigation/settings configuration, communication preferences, custom fields, training funds, and voucher codes.

## Deployment Architecture

Development uses Express.js with Vite middleware. Production deploys to Vercel serverless functions for API and static assets. Data sync from Zoho CRM is one-way, triggered by member login or admin actions. Data freshness is maintained using TanStack Query and Supabase Realtime Subscriptions.

## API Architecture (Jan 2026)

**Vercel Serverless Functions:** All API endpoints are implemented as Vercel serverless functions in the `/api/` directory. In local development, `server/vercel-api-adapter.ts` routes `/api/*` requests to these handlers.

**Database Configuration:**
- `api/_lib/database.js` - Centralized Supabase client
- `api/_lib/session.js` - Session management with `iconnect.sid` cookie
- Environment variables use the same names (`SUPABASE_URL`, `DATABASE_URL`, etc.) with different values per Vercel environment scope

**Environment Isolation (Jan 2026):**
- Vercel Production → Production database (`zkvgzcruhniduuswbfyh`)
- Vercel Preview → Development database (`lvmzliemqnieeoruhkik`)
- Replit local → Development database (via `DEV_*` variables)

**Key API Files:**
- `api/entities/[entity]/index.js` - Generic entity CRUD
- `api/entities/[entity]/[id].js` - Single entity operations
- `api/functions/[functionName].js` - Server-side functions
- `api/health.js` - Health check endpoint

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

## Member Field Permissions (Jan 2026)

Role-based field access control for member profile fields on the About-me page, mirroring the Organization Field Permissions feature.

**Database Table:**
- `role_member_field_permission` - Stores field permissions per role

**Table Structure:**
- `id` (UUID primary key)
- `role_id` - The role this permission applies to
- `field_key` - Core field name (first_name, last_name, profile_photo_url, job_title, mobile, landline, biography, show_in_directory)
- `permission` - One of: 'hidden', 'read', 'read_write'

**API Endpoints:**
- `GET /api/roles/[roleId]/member-field-permissions` - Get permissions for a role (admin only)
- `PUT /api/roles/[roleId]/member-field-permissions` - Update permissions for a role (admin only)
- `GET /api/my-member-field-permissions` - Get current member's field permissions (authenticated)

**Admin UI:**
- MemberPreferences page (`/MemberPreferences`) - Manage field permissions per role

**Frontend Integration:**
- Preferences.jsx (About-me page) fetches member field permissions
- Helper functions: `getFieldPermission()`, `canEditField()`, `isFieldVisible()`
- Fields render as read-only or hidden based on role permissions

**Access Control:**
- Feature key: `page_admin_MemberPreferences` maps to `membership.member-field-permissions`

## Email Template Placeholder System

The platform supports dynamic email templates with placeholder substitution for form submissions. Forms can send multiple emails per submission with independent configurations, allowing for system and custom placeholders mapped to form fields. The backend handles placeholder replacement and supports backward compatibility with legacy single email fields.

## Entity Pipelines System

Forms use a unified `entity_pipelines` system to configure member and organization record creation/updates on form submission. This system uses a `mappings` array for each entity entry, supporting transformations and both field-based and static value sources. The UI is integrated into the FormBuilder, and processing logic handles primary and additional entity UPSERTs, deduplication, and field clearing using a `__clear__` sentinel value. It maintains backward compatibility with legacy form fields.

## Form Conditional Logic Visibility System

Forms support conditional visibility rules that control the visibility and enabled state of fields based on other field values. Rules specify `visible` and `enabled` states (true/false/null) for target fields.

## Notes System (Jan 2026)

Both Organizations and Members support internal notes that admins can add, edit, and delete:

**Database Tables:**
- `organization_note` - Notes attached to organization records
- `member_note` - Notes attached to member records

**Table Structure:**
- `id` (UUID primary key)
- `target_member_id` or `organization_id` - The entity the note is about
- `author_member_id` or `member_id` - Who created the note
- `content` (text) - The note content
- `attachments` (JSONB) - Array of file attachments (organization notes only)
- `created_at`, `updated_at` timestamps

**API Endpoints:**
- `GET/POST /api/admin/organizations/[id]/notes` - List/create org notes
- `PATCH/DELETE /api/admin/organization-notes/[noteId]` - Update/delete org notes
- `GET/POST /api/admin/members/[id]/notes` - List/create member notes
- `PATCH/DELETE /api/admin/member-notes/[noteId]` - Update/delete member notes

**UI Components:**
- Notes tab in OrganisationDetailView (with file attachments)
- Notes tab in MemberDetailView (text only)

# External Dependencies

**Supabase:** Primary database (PostgreSQL) for application data, including CRUD and realtime subscriptions, and file storage.
**Zoho CRM:** Contact and account synchronization.
**Zoho Backstage:** Event management and ticket sales integration.
**Stripe:** Payment processing.
**Xero:** Invoice generation.
**Email Delivery:** For magic links and notifications.