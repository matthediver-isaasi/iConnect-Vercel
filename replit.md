# Overview

This project is a multi-tenant SaaS membership management platform designed to provide an all-in-one solution for organizations. It handles members, events, bookings, resources, and blog posts, integrating comprehensive administrative functions with external services. The platform supports a three-tier hierarchy (TENANT, ORGANIZATION, MEMBER) with robust access control and data isolation. Key features include a unified identity system, dynamic page builder, custom forms, workflow automation, and a comprehensive Due Diligence process. The platform aims to consolidate organizational management into a single, efficient solution with significant market potential for various organizations.

# User Preferences

Preferred communication style: Simple, everyday language.

# System Architecture

## Frontend
The frontend uses React 18 (TypeScript/JSX), Vite, TanStack Query, shadcn/ui (Radix UI), and Tailwind CSS. It features client-side routing and a custom "new-york" design system.

## Backend
The backend is built with Express.js, PostgreSQL (Neon serverless), and Drizzle ORM. It provides a generic entity CRUD API, password-based authentication, server-side session management, and an admin security model with role-based access control. All API endpoints are deployed as Vercel serverless functions.

## Multi-Tenant SaaS Architecture
The platform ensures data isolation across GLOBAL, TENANT, ORGANIZATION, and MEMBER levels, with data primarily scoped by `tenant_id` and sub-filtered by `organization_id`.

## Unified Identity System
A central `tenant_identity` table manages user authentication, supporting multiple tenant ownership and organization memberships, with per-tenant password isolation and Google OAuth.

## Deployment & Domain Architecture
The application is deployed on Vercel, using `iconn.app` for tenant owner management and `{tenant}.iconn.app` for member portals, facilitated by cross-subdomain session cookies.

## Core Data Model & Features
The data model includes Member, Organization, Role, and TeamMember. Features encompass role segmentation, event/booking management, content management, a dynamic page builder, custom forms with conditional logic, workflows, Speaker profiles, Card Deck content, navigation/settings, communication preferences, custom fields, training funds, voucher codes, and internal notes.

## Role Management System
A feature-based role management system controls UI visibility and backend access, including protected system roles and role-based field access control for member profiles.

## Email Template Placeholder System
Supports dynamic email templates with placeholder substitution for form submissions, allowing multiple emails per submission.

## Due Diligence Process Flow
A workflow system for reviewing form submissions, scoring applicants, sending contracts for signature, and handling contract timeouts with alternative signers. It includes user-created forms, configurable stages, and actions (Send Email, Create Contract, Send Meeting Request).

## Platform Owner Configuration System
A third authentication tier provides "Platform Owners" with super-admin capabilities for platform-wide preferences and tenant management.

## Tenant Branding System
Allows per-tenant branding customization for public-facing pages, storing `primary_color`, `secondary_color`, `tagline`, `logo_url`, `header_config`, and `footer_config` as JSONB.

## Form Embedding System
Forms can be embedded on external websites via iFrame, with a public API for data and an embed page for rendering.

## Public API Client
Public-facing pages use a centralized `publicClient` for tenant-aware API requests, ensuring multi-tenant data isolation for unauthenticated users.

## Public Page API Pattern (IMPORTANT)

Public pages (landing pages, events, articles, job board) must work for unauthenticated users without 401 errors. This requires using public endpoints instead of authenticated `base44.entities` calls.

### Key Files

| File | Purpose |
|------|---------|
| `client/src/api/publicClient.js` | Frontend client for public API endpoints |
| `api/public/system-settings.js` | Public system settings endpoint with whitelist |
| `api/public/*.js` | All public API endpoints |

### Available Public Endpoints

| Endpoint | Purpose |
|----------|---------|
| `/api/public/system-settings` | Whitelisted system settings |
| `/api/public/events` | Public events listing |
| `/api/public/articles` | Public articles/blog posts |
| `/api/public/job-postings` | Public job board |
| `/api/public/forms` | Public forms for embedding |
| `/api/public/pages` | Dynamic page content |
| `/api/public/organizations` | Organization directory |

### PUBLIC_SETTINGS_WHITELIST

System settings exposed to unauthenticated users are controlled by `PUBLIC_SETTINGS_WHITELIST` in `api/public/system-settings.js`. To expose a new setting publicly:

```javascript
const PUBLIC_SETTINGS_WHITELIST = [
  'landing_page_id',
  'primary_color',
  'date_display_format',
  'event_types',
  // Add new settings here
];
```

### Frontend Usage Patterns

**For public pages** - Use `publicClient`:
```javascript
import { publicClient } from "@/api/publicClient";

const { data } = useQuery({
  queryKey: ['public-system-settings'],
  queryFn: () => publicClient.listSystemSettings(),
});
```

**For authenticated pages** - Use `base44.entities`:
```javascript
import { base44 } from "@/api/base44Client";

const { data } = useQuery({
  queryKey: ['system-settings'],
  queryFn: () => base44.entities.SystemSettings.list(),
});
```

### Query Gating Pattern

For components used on both public AND authenticated pages, gate authenticated queries to prevent 401 errors:

```javascript
const { memberInfo } = useMemberAuth();

const { data: zoomMeetings } = useQuery({
  queryKey: ['zoom', 'meetings'],
  queryFn: () => base44.entities.ZoomMeeting.list(),
  enabled: !!memberInfo, // Only runs when user is authenticated
});
```

### Common Mistakes to Avoid

1. **Using `base44.entities` in hooks used by public pages** - Switch to `publicClient`
2. **Forgetting to add settings to whitelist** - New public settings must be added to `PUBLIC_SETTINGS_WHITELIST`
3. **Not gating authenticated queries** - Use `enabled: !!memberInfo` for queries that should only run when logged in

## Session Validation Security Pattern
Hybrid pages use a `sessionValidated` flag to prevent unauthenticated users from accessing member-only data due to stale localStorage.

## API Authentication Pattern
The platform supports two types of authenticated sessions: Member sessions (portal users) and Tenant user sessions (admin dashboard users). `getTenantContext(req)` is the preferred function for handling both, providing `tenantId`, `memberId`, and `isAuthenticated`. `getSessionTenantUser(req)` is for admin-only endpoints, and `getSessionMember(req)` for member-only endpoints. Queries on public pages that depend on authentication must be gated using `enabled: !!memberInfo` to prevent 401 errors.

## Tenant Email Domain Provisioning System
Supports automated Mailgun domain provisioning for each tenant, enabling tenant-specific email sending domains with Vercel DNS record creation.

## Collapsible Sidebar Implementation
The authenticated portal uses Shadcn's collapsible sidebar with ref-forwarding, tooltips for collapsed icons, and adaptive footer content.

## Cross-Organization Access Control (CRM)
Access to organization-scoped data for write operations is controlled by role permissions, restricting regular members to their own organization's data.

## Workflow Automation System
Tenant-scoped entities enable automated actions based on entity events (organization, member, job_posting) with optional user confirmation for field change triggers.

## Supabase Realtime Subscriptions
The frontend uses Supabase Realtime for database change subscriptions, providing tenant-scoped subscriptions via `useRealtimeSubscription` hook to invalidate TanStack Query cache keys.

## Contract Signing Module
Built on the FormBuilder infrastructure, this system enables structured forms with signature fields for electronic signatures, supporting multi-signer workflows and automated reminders.

## Agent Booking System with Meeting Templates
A booking system allows team members as "booking agents" with personal booking pages, including tenant-scoped meeting templates, agent-template assignments, and integration with due diligence workflows.

## Data Migration System
A reusable migration solution transfers data from a legacy single-tenant Supabase database to the new multi-tenant application, adding `tenant_id` to all migrated data. This involves two main steps: data migration and credential migration, with a utility for fixing duplicate member records.

# External Dependencies

-   **Supabase:** Primary database (PostgreSQL) and file storage.
-   **Stripe:** Payment processing.
-   **Xero:** Invoice generation.
-   **Microsoft Graph API:** Outlook email integration.
-   **Mailgun:** Tenant-specific email sending domains and email delivery.