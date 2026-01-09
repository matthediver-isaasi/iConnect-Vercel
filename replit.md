# Overview

This project is a comprehensive membership management platform built with React (Vite) and Express.js. It manages members, organizations, events, bookings, program tickets, resources, and blog posts, along with administrative functions. The platform aims for 100% visual and functional parity with its predecessor (Base44) using modern technologies. Its core purpose is to streamline membership operations, event management, and content delivery for organizations, integrating with various external services for CRM, payments, and accounting to provide a robust, all-in-one solution.

# User Preferences

Preferred communication style: Simple, everyday language.

# System Architecture

## Frontend Architecture

The frontend uses React 18 with TypeScript/JSX, Vite, TanStack Query, shadcn/ui (Radix UI), and Tailwind CSS for styling. It implements client-side routing and a customized "new-york" shadcn/ui design system for visual parity.

## Backend Architecture

The backend is built with Express.js and uses PostgreSQL (Neon serverless) with Drizzle ORM. It follows a generic entity CRUD API pattern, with password-based authentication and server-side session management. An admin security model implements role-based access control. Server-side functions handle specific operations like magic links, Stripe payments, bookings, and event synchronization.

## API Architecture

All API endpoints are implemented as Vercel serverless functions in the `/api/` directory. In local development, `server/vercel-api-adapter.ts` routes `/api/*` requests to these handlers. Session management uses `api/_lib/session.js` and database access uses `api/_lib/database.js`. Environment variables are managed per Vercel environment scope.

### Multi-Tenant SaaS Architecture

The platform is designed as a multi-tenant SaaS product with a three-tier hierarchy: TENANT (subscribing company), ORGANIZATION (organizational members within a tenant), and MEMBER (individual people within organizations). A `tenant` table stores SaaS subscribing companies, and `api/_lib/tenantContext.js` defines entity scopes. Access control enforces data isolation at GLOBAL, TENANT, ORGANIZATION, and MEMBER levels, ensuring records are scoped to the authenticated user's context.

### Dual Authentication System

The platform uses two separate authentication systems:
1. **tenant_user** (SaaS-level): For platform admins managing billing, domains, and tenant settings. Login at iconn.app (root domain).
2. **member** (Portal-level): For organizational members accessing the membership portal. Login at tenant subdomains (*.iconn.app).

**SSO Flow (SaaS → Portal):** When a tenant_user clicks "Open Portal" on the SaaS dashboard:
1. `/api/admin/portal-session` generates a short-lived (5 min) single-use token
2. User is redirected to tenant subdomain with token: `gfi.iconn.app/api/auth/portal-sso?token=xxx`
3. `/api/auth/portal-sso` validates token, creates member session, redirects to landing page

**Linking table:** `tenant_user_member_link` connects tenant_user accounts to their member accounts for SSO. During tenant provisioning, both accounts are created with the same credentials and automatically linked.

### Google OAuth Integration

Both authentication tiers support "Sign in with Google" as an alternative to password-based login:

**Portal Member OAuth (subdomain login - centralized auth):**
- `/api/auth/google`: Initiates OAuth flow from tenant subdomain, redirects to Google
- `/api/auth/google/callback`: Exchanges code for tokens at iconn.app root domain, then redirects back to tenant subdomain
- **Centralized Auth Pattern**: Since Google doesn't support wildcard redirect URIs, all member OAuth callbacks go through `https://iconn.app/api/auth/google/callback`, then redirect to the tenant subdomain stored in state
- Session cookies are set on `.iconn.app` domain for cross-subdomain sharing
- Tenant isolation: Members must belong to the subdomain's tenant to authenticate
- Account linking: First Google login on existing email account automatically links Google ID

**Tenant User OAuth (root domain login):**
- `/api/tenant/auth/google`: Initiates OAuth flow for SaaS admin login
- `/api/tenant/auth/google/callback`: Exchanges code, creates tenant_user session
- Account linking: First Google login on existing email account automatically links Google ID

**Database Columns:**
- `member.google_id`: Stores Google account ID for portal members
- `tenant_user.google_id`: Stores Google account ID for tenant admins

**Environment Variables (Vercel secrets):**
- `GOOGLE_CLIENT_ID`: OAuth client ID from Google Cloud Console
- `GOOGLE_CLIENT_SECRET`: OAuth client secret

**Tenant Signup with Google:**
- `/api/tenant/auth/google-signup`: Initiates OAuth flow for new tenant registration
- `/api/tenant/auth/google-signup/callback`: Exchanges code, stores signed data in HttpOnly cookie
- `/api/tenant/auth/google-signup/data`: API to retrieve Google profile data from signed cookie
- Provisions tenant without password when using Google (google_id stored instead)
- Deduplication: Checks both email and google_id to prevent duplicate tenant owners

**Setup:**
1. Run `scripts/migrations/add-google-oauth-columns.sql` in Supabase SQL Editor
2. Configure Google OAuth credentials in Google Cloud Console
3. Add redirect URIs: `https://iconn.app/api/tenant/auth/google/callback`, `https://iconn.app/api/tenant/auth/google-signup/callback`, and `https://*.iconn.app/api/auth/google/callback`
4. Add `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` to Vercel environment variables

## Deployment Architecture

Development uses Express.js with Vite middleware. Production deploys to Vercel serverless functions for API and static assets. Data freshness is maintained using TanStack Query and Supabase Realtime Subscriptions.

## Session Security

Immediate session invalidation is enforced when a member's `login_enabled` is set to false, a member is deleted, or an organization is deleted. The `getSessionMember()` function validates `login_enabled` status on every authenticated request, and `invalidateMemberSessions()` is used proactively during admin actions.

## Data Model

The data model includes core entities like Member, Organization, Role, TeamMember, supporting role segmentation, event/booking management (application-native events, guest checkout), content management (BlogPost, Resource), and a dynamic page builder. It also supports a custom forms system, workflows for automation, Speaker profiles, Card Deck content, navigation/settings configuration, communication preferences, custom fields, training funds, and voucher codes.

## Runtime Page Provisioning (CMS Feature)

A CMS feature allows administrators to create and manage dynamic pages and routes at runtime using a `/:slug` catch-all route, supporting draft/published statuses and public/member access controls.

## Role Management System

The role management system uses a hierarchical Module→Page→Feature structure to control visibility via `excluded_features` arrays stored in roles. Access control is 100% feature-based, with backend endpoints checking specific feature exclusions and UI components dynamically adjusting visibility. The binary `is_admin` concept has been fully deprecated.

### System Role Protection

System roles (like "Super Admin") are protected from modification and deletion using an `is_system` flag on the `role` table. Protection is enforced at three layers:
1. **Database layer**: A PostgreSQL trigger (`protect_system_roles`) prevents deletion and renaming of system roles
2. **API layer**: Guards in `api/entities/[entity]/[id].js` check `is_system` before allowing DELETE or PATCH operations on roles
3. **UI layer**: Role management interface disables delete/rename controls for system roles

**Important**: Run `scripts/add-role-is-system-flag.sql` in Supabase SQL Editor to add the `is_system` column, backfill existing admin roles, and create the protection trigger.

## Member Field Permissions

Role-based field access control for member profile fields on the About-me page. Permissions (`hidden`, `read`, `read_write`) are stored in the `role_member_field_permission` table per role and enforced via API endpoints and frontend integration.

## Email Template Placeholder System

The platform supports dynamic email templates with placeholder substitution for form submissions. Forms can send multiple emails per submission with independent configurations, allowing for system and custom placeholders mapped to form fields.

## Entity Pipelines System

Forms use a unified `entity_pipelines` system to configure member and organization record creation/updates on form submission. This system uses a `mappings` array for each entity entry, supporting transformations, and handles primary and additional entity UPSERTs, deduplication, and field clearing.

## Form Conditional Logic Visibility System

Forms support conditional visibility rules that control the visibility and enabled state of fields based on other field values.

## Notes System

Organizations and Members support internal notes that admins can add, edit, and delete, stored in `organization_note` and `member_note` tables respectively. Organization notes support file attachments.

## Platform Owner Configuration System

A third authentication tier exists for platform-wide SaaS administration:

**Platform Owner:** Super-admins who manage the entire SaaS platform, not tied to any specific tenant.
- Separate authentication system with secure server-side session management
- Sessions stored in `platform_owner_session` table with cryptographically strong 32-byte tokens
- Access at `/platform/admin` route on any domain (root or subdomain)
- Manages platform-wide preferences stored in `platform_preferences` table

**Role Templates:**
- Platform admins configure default role templates that are used when provisioning new tenants
- Stored in `platform_preferences` with key `default_role_templates`
- Templates are independent snapshots - changes to GFI roles don't affect templates
- Each template includes: name, excluded_features, default_landing_page, is_system, member_field_permissions, organization_field_permissions

**Database Tables:**
- `platform_owner`: Platform admin accounts (email, password_hash, name, is_active)
- `platform_owner_session`: Server-side session store (session_token, owner_id, expires_at)
- `platform_preferences`: Key-value store for platform configuration (key, value, description)

**Setup Scripts:**
- `scripts/migrations/add-platform-owner-tables.sql`: Creates the platform tables (run in Supabase SQL Editor)
- `scripts/migrations/update-role-trigger-allow-tenant-delete.sql`: Updates the system role protection trigger to allow bypass during tenant deletion
- `scripts/create-platform-owner.js`: Creates a platform owner account
- `scripts/seed-role-templates.js`: Snapshots GFI tenant roles as default templates
- `scripts/seed-navigation-templates.js`: Snapshots GFI portal navigation as templates for new tenants

**Tenant Deletion:**
- Platform owners can delete entire tenants via `/api/platform/tenants/delete`
- Deletion requires confirmSlug to match the tenant's subdomain (two-step safety)
- Uses `enable_tenant_deletion_mode()` RPC to temporarily bypass the system role protection trigger
- Deletes all related records in FK-safe order before deleting the tenant record

**Navigation Templates:**
- Platform preferences key `default_navigation_templates` stores portal navigation configuration
- Templates include: `portal_navigation_items`, `portal_menus`, `navigation_items` (public site)
- New tenants automatically receive navigation from templates during provisioning
- Run `scripts/seed-navigation-templates.js` after configuring GFI navigation to update templates

**API Endpoints:**
- `/api/platform/auth/login|logout|session`: Platform owner authentication
- `/api/platform/preferences`: CRUD for platform preferences
- `/api/platform/role-templates`: Get/update role templates

# External Dependencies

**Supabase:** Primary database (PostgreSQL) for application data, including CRUD and realtime subscriptions, and file storage.
**Stripe:** Payment processing.
**Xero:** Invoice generation with multi-tenant isolation.
**Email Delivery:** For magic links and notifications.

## Xero Multi-Tenant Integration

Xero OAuth tokens are scoped to individual tenants via `app_tenant_id` in the `xero_token` table:

- `getValidXeroAccessToken(appTenantId)` requires the appTenantId parameter to ensure tokens are isolated per tenant
- OAuth callback (`/api/xero/callback`) stores `app_tenant_id` from the state parameter
- `createXeroInvoice()`, `testXeroPaymentRecording()` require `appTenantId` in params
- `updateXeroInvoicePO()` derives tenant from the authenticated member's `tenant_id`
- `getXeroConnectionStatus()` accepts optional `appTenantId` for tenant-scoped status checks
- VAT rates are stored with tenant-specific keys: `xero_vat_rates_${appTenantId}` in `system_settings`
- In booking flows, tenant_id is derived from `event.tenant_id` or `member.tenant_id`