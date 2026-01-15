# Overview.

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

**Member Entity Scope (Updated Jan 2026):**
- Members are now TENANT-scoped, not ORGANIZATION-scoped
- This allows individual members to exist without belonging to an organization
- `organization_id` on the member table is optional - null for individuals, populated for org staff
- A database trigger auto-populates `tenant_id` from organization when `organization_id` is provided
- Tenants like GSF can have both organizational members (company staff) and individual members

## Unified Identity System

The platform uses a centralized `tenant_identity` table for ALL user authentication (owners and members). This enables:
- A single user (by email) to own multiple tenants AND be a member in multiple organizations
- Seamless tenant switching between owned and member tenants
- Per-tenant password isolation (passwords can be different for each tenant)

The `tenant_membership` table tracks user relationships to tenants with:
- `identity_id`: Links to the user's central identity
- `membership_type`: Either 'owner' (admin access) or 'member' (portal access)
- `member_id`: Optional link to a member record for portal functionality
- Session types are determined by membership_type: `tenant_user` for owners, `member` for portal users

**Per-Tenant Password Isolation (Updated Jan 2026):**
- The `tenant_membership_credentials` table stores passwords per identity+tenant combination
- Users can have DIFFERENT passwords for different tenants they belong to
- Resetting password in tenant A does NOT affect password in tenant B
- Login flow: Check tenant-specific credentials first, fall back to shared password for backwards compatibility
- Password reset tokens are stored in tenant_membership_credentials for isolation
- Migration script: `scripts/migrations/add-tenant-membership-credentials.sql`

Schema for tenant_membership_credentials:
- `identity_id`: Links to tenant_identity
- `tenant_id`: Links to tenant
- `password_hash`: Bcrypt hash of tenant-specific password
- `reset_token`, `reset_token_expires`: For password reset flow
- `failed_attempts`, `locked_until`: For account lockout
- `last_login`: Timestamp of last login using this credential

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

## Tenant Branding System

The platform supports per-tenant branding customization for public-facing pages. Key components:

- **Database Schema**: The `tenant` table includes branding fields: `primary_color`, `secondary_color`, `tagline`, `logo_url`, `header_config`, `footer_config`, and `branding_config` (all stored as JSONB for flexibility)
- **Public API**: `/api/public/tenant-branding` endpoint returns tenant branding based on subdomain detection (e.g., `gsf.iconn.app` → tenant "gsf")
- **React Context**: `TenantBrandingContext` provides branding data throughout the app via `useTenantBranding()` hook
- **PublicLayout Integration**: The public footer uses tenant branding for:
  - CTA text, button text, and links
  - Footer gradient colors (customizable array of colors)
  - Address and contact information
  - Tenant logo (displayed with invert filter for dark footer)
  - Legal/charity text
  - Terms and privacy policy URLs
  - Newsletter signup text

Footer configuration structure:
```javascript
{
  ctaText: "Become a member today",
  ctaButtonText: "Join Us", 
  ctaLink: "Membership",
  newsletterText: "Sign up to our newsletter",
  gradientColors: ["#5C0085", "#BA0087", "#EE00C3", "#FF4229", "#FFB000"],
  address: { name: "Org Name", lines: ["Line 1", "Line 2"] },
  contact: { phone: "+44...", email: "hello@..." },
  legalText: "Registered charity...",
  termsAndConditionsUrl: "https://...",
  privacyPolicyUrl: "https://..."
}
```

## Form Embedding System

Forms can be embedded on external websites via iFrame. Key components:

- **Public API**: `/api/public/form/[slug]` endpoint returns form data for rendering (tenant-scoped, no auth required)
- **Embed Page**: `/embed/form/:slug` renders a standalone form without the application's layout/header/footer
- **FormBuilder Integration**: When editing a form, an "Embed on External Websites" section displays:
  - iFrame embed code with copy-to-clipboard
  - Auto-resize script for dynamic height adjustment
  - Preview button to test the embedded form

Security measures:
- Forms with `require_authentication=true` cannot be embedded publicly (403 response)
- Tenant scoping prevents cross-tenant form access
- Only public-safe fields are returned (excludes internal config like entity_pipelines)
- Auto-resize script validates message origin before applying height changes

Entities migrated to tenant_id only (no organization_id column): PortalMenu, PortalNavigationItem, NavigationItem, PageBanner, Floater, FormDueDiligenceConfig, FormSubmissionDueDiligence, Form, ResourceCategory, Resource

## Outlook Email Integration (CRM Feature)

The platform supports Microsoft Outlook integration for email tracking on member records, similar to CRM systems. Key components:

- **Database Schema**: 
  - `outlook_connection` table stores OAuth tokens per user (tenant_id, identity_id, access_token, refresh_token, etc.)
  - `member_email` table stores synced emails linked to members (subject, body, direction, timestamps, etc.)
  - Migration script: `scripts/migrations/add-outlook-email-integration.sql`

- **OAuth Flow**:
  - `/api/auth/outlook` initiates Microsoft OAuth with Mail.Read, Mail.Send, and offline_access scopes
  - `/api/auth/outlook/callback` exchanges auth code for tokens and stores in database
  - Uses multi-tenant app registration (common authority) so any Microsoft 365 user can connect

- **API Endpoints**:
  - `GET /api/outlook/status` - Check connection status
  - `DELETE /api/outlook/status` - Disconnect Outlook
  - `POST /api/outlook/sync` - Sync emails from Microsoft Graph matching member email addresses
  - `POST /api/outlook/send` - Send email via Microsoft Graph and log to member record
  - `GET /api/outlook/emails/[memberId]` - Get emails for a specific member

- **UI Components**:
  - `OutlookConnection.jsx` - Connect/disconnect Outlook in AdminSettings
  - `MemberEmails.jsx` - Email history list on AdminMemberEdit page
  - `ComposeEmailModal.jsx` - Send new emails from member records

- **Token Management**: Automatic token refresh when expired, status updates on connection failure

- **Environment Variables**:
  - `MICROSOFT_CLIENT_ID` - Azure app registration client ID
  - `MICROSOFT_CLIENT_SECRET` - Azure app registration client secret

# External Dependencies

**Supabase:** Primary database (PostgreSQL) for application data, including CRUD and realtime subscriptions, and file storage.
**Stripe:** Payment processing.
**Xero:** Invoice generation with multi-tenant isolation.
**Microsoft Graph API:** Outlook email integration for CRM-style email tracking on member records.
**Email Delivery:** For magic links and notifications.