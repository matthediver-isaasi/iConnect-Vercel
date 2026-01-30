# Overview

This project is a multi-tenant SaaS membership management platform providing an all-in-one solution for organizations to manage members, events, bookings, resources, and blog posts. It integrates comprehensive administrative functions with external services. The platform supports a three-tier hierarchy (TENANT, ORGANIZATION, MEMBER) with robust access control and data isolation, aiming to consolidate organizational management into a single, efficient solution with significant market potential. Key capabilities include a unified identity system, dynamic page builder, custom forms, workflow automation, and a comprehensive Due Diligence process.

# User Preferences

Preferred communication style: Simple, everyday language.

# System Architecture

## Frontend
The frontend uses React 18 (TypeScript/JSX), Vite, TanStack Query, shadcn/ui (Radix UI), and Tailwind CSS, featuring client-side routing and a custom "new-york" design system.

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

## Public API Pattern
Public pages must work for unauthenticated users, utilizing `publicClient` for tenant-aware API requests to specific public endpoints (e.g., `/api/public/system-settings`, `/api/public/events`). System settings exposed publicly are controlled by a `PUBLIC_SETTINGS_WHITELIST`. Authenticated pages use `base44.entities`. Query gating (`enabled: !!memberInfo`) is used to prevent 401 errors on components shared between public and authenticated contexts.

## Complex Page Pattern (Navigation Blocking Prevention)
To prevent React Router navigation blocking on complex pages with many queries (e.g., `MemberDetail.jsx`), data fetching is lazy-loaded using tab-based query gating (`enabled: !!id && activeTab === 'tabname'`) to only fetch data when a specific tab is active.

## Server-Side Pagination Pattern
For large lists (1000+ records), server-side pagination is implemented with dedicated paginated endpoints. Frontend uses `useDebounce` for search, `keepPreviousData` to prevent flicker, and includes all filter parameters in `queryKey` for proper caching.

## Session Validation Security Pattern
Hybrid pages use a `sessionValidated` flag to prevent unauthenticated users from accessing member-only data due to stale localStorage.

## API Authentication Pattern
The platform supports member sessions (portal users) and tenant user sessions (admin dashboard users). The `getTenantContext(req)` function is the preferred method for authentication, handling both session types and returning context including `tenantId`, `memberId`, and `isAuthenticated`. `getSessionTenantUser(req)` is for admin-only endpoints, and `getSessionMember(req)` for member-only endpoints.

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
A reusable migration solution transfers data from a legacy single-tenant Supabase database to the new multi-tenant application, adding `tenant_id` to all migrated data, including credential migration and duplicate member record fixing.

# External Dependencies

-   **Supabase:** Primary database (PostgreSQL) and file storage.
-   **Stripe:** Payment processing.
-   **Xero:** Invoice generation.
-   **Microsoft Graph API:** Outlook email integration.
-   **Mailgun:** Tenant-specific email sending domains and email delivery.

---

# ⚠️ CRITICAL: Database Connection Instructions (DO NOT DELETE)

This project uses Supabase PostgreSQL databases. **Direct psql commands DO NOT WORK on Replit** due to IPv6 connectivity issues.

## Available Database Secrets

| Secret | Database | Purpose |
|--------|----------|---------|
| `SOURCE_DATABASE_URL` | Legacy single-tenant Supabase | Original data source for migrations |
| `DEST_DATABASE_URL` | New multi-tenant Supabase | Production destination database |
| `SOURCE_SUPABASE_URL` | Legacy Supabase project URL | For storage access |
| `SOURCE_SUPABASE_KEY` | Legacy Supabase service key | For storage access |
| `DEST_SUPABASE_URL` | New Supabase project URL | For storage access |
| `DEST_SUPABASE_KEY` | New Supabase service key | For storage access |

## How to Query the Database

**USE NODE.JS SCRIPTS - NOT psql or execute_sql_tool**

Create a script like `scripts/debug-query.mjs`:

```javascript
import { createClient } from '@supabase/supabase-js';

// For destination (multi-tenant) database:
const supabaseUrl = 'https://lvmzliemqnieeoruhkik.supabase.co';
const supabaseKey = process.env.DEST_SUPABASE_KEY; // Service role key

const supabase = createClient(supabaseUrl, supabaseKey);

// Example query
const { data, error } = await supabase
  .from('member')
  .select('*')
  .eq('tenant_id', 'fd82da65-aab7-4a5c-85b8-b2febeb2003d')
  .limit(10);

console.log(data);
```

Run with: `node scripts/debug-query.mjs`

## Important Notes

- **Replit's built-in database tools won't work** - The execute_sql_tool and psql fail due to IPv6 routing issues
- **Always use Supabase client** - Use `@supabase/supabase-js` for all database operations
- **Tenant ID for migrations:** `fd82da65-aab7-4a5c-85b8-b2febeb2003d`
- See `scripts/debug-tenant.mjs` for a working example of database queries

---

## Cross-Storage File Migration Script

**Script:** `scripts/migrations/migrate-files-cross-storage.js`

### Usage

```bash
# Dry-run all tables (preview only, no changes)
node scripts/migrations/migrate-files-cross-storage.js --tenant-id=fd82da65-aab7-4a5c-85b8-b2febeb2003d --dry-run

# Dry-run specific table
node scripts/migrations/migrate-files-cross-storage.js --tenant-id=fd82da65-aab7-4a5c-85b8-b2febeb2003d --dry-run --tables=member

# Run migration for specific tables
node scripts/migrations/migrate-files-cross-storage.js --tenant-id=fd82da65-aab7-4a5c-85b8-b2febeb2003d --tables=member,organization

# Run all tables with batch size
node scripts/migrations/migrate-files-cross-storage.js --tenant-id=fd82da65-aab7-4a5c-85b8-b2febeb2003d --batch-size=10
```

### Supported Tables

| Table | Description |
|-------|-------------|
| `file_repository` | File attachments |
| `form_submission` | Form uploads (recursive JSON scan) |
| `form_draft_submission` | Draft form uploads (recursive JSON scan) |
| `system_settings` | Tenant branding/logos |
| `member` | Profile photos |
| `organization` | Organization logos |
| `tenant` | Tenant branding assets |
| `news_post` | News featured images + content |
| `i_edit_page` | Page builder elements (recursive JSON scan) |
| `resource` | Resource files (dynamic URL detection) |
| `event` | Event images (dynamic URL detection) |
| `job_posting` | Job posting images (dynamic URL detection) |
| `blog_post` | Blog featured images |
| `page_banner` | Banner images + config (recursive JSON scan) |
| `speaker` | Speaker photos |
| `card_deck` | Card deck images (recursive JSON scan) |
| `navigation_item` | Nav icons + config (recursive JSON scan) |
| `i_edit_page_element` | Page element configs (recursive JSON scan) |
| `wall_of_fame` | Photos + section backgrounds |

### Required Environment Variables

- `SOURCE_SUPABASE_URL` - Legacy Supabase project URL
- `SOURCE_SUPABASE_KEY` - Legacy Supabase service role key
- `DEST_SUPABASE_URL` - New Supabase project URL
- `DEST_SUPABASE_KEY` - New Supabase service role key

---

## Verify File Migration Script

**Script:** `scripts/migrations/verify-file-migration.js`

Checks the destination database for any records that still contain URLs pointing to the source Supabase storage. Useful for verifying migration completeness.

### Usage

```bash
# Check all tables
node scripts/migrations/verify-file-migration.js --tenant-id=fd82da65-aab7-4a5c-85b8-b2febeb2003d

# Check specific tables
node scripts/migrations/verify-file-migration.js --tenant-id=fd82da65-aab7-4a5c-85b8-b2febeb2003d --tables=member,organization

# Verbose mode (show individual URLs found)
node scripts/migrations/verify-file-migration.js --tenant-id=fd82da65-aab7-4a5c-85b8-b2febeb2003d --verbose
```

### Exit Codes

- `0` - All tables clean, no source URLs found
- `1` - Source URLs found in one or more tables

---