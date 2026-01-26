# Overview

This project is a multi-tenant SaaS membership management platform providing an all-in-one solution for organizations.

---

# ⚠️ CRITICAL: Database Connection Instructions

**This project uses Supabase PostgreSQL databases. Direct `psql` commands DO NOT WORK on Replit due to IPv6 connectivity issues.**

## Available Database Secrets

| Secret | Database | Purpose |
|--------|----------|---------|
| `SOURCE_DATABASE_URL` | Legacy single-tenant Supabase | Original data source for migrations |
| `DEST_DATABASE_URL` | New multi-tenant Supabase | Production destination database |

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

1. **Replit's built-in database tools won't work** - The execute_sql_tool and psql fail due to IPv6 routing issues
2. **Always use Supabase client** - Use `@supabase/supabase-js` for all database operations
3. **Tenant ID for migrations**: `fd82da65-aab7-4a5c-85b8-b2febeb2003d`
4. **See `scripts/debug-tenant.mjs`** for a working example of database queries

---

It handles members, events, bookings, resources, and blog posts, integrating comprehensive administrative functions with external services. The platform supports a three-tier hierarchy (TENANT, ORGANIZATION, MEMBER) with robust access control and data isolation. Key features include a unified identity system, dynamic page builder, custom forms, workflow automation, and a comprehensive Due Diligence process. The platform aims to consolidate organizational management into a single, efficient solution with significant market potential for various organizations.

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

## Public API Client
Public-facing pages use a centralized `publicClient` for tenant-aware API requests, ensuring multi-tenant data isolation for unauthenticated users.

## Session Validation Security Pattern
Hybrid pages use a `sessionValidated` flag to prevent unauthenticated users from accessing member-only data due to stale localStorage.

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

# Data Migration System

## Overview

A reusable migration solution transfers data from the legacy single-tenant Supabase database to the new multi-tenant application. The migration handles ~10,800 records across 80+ shared tables, adding `tenant_id` to all migrated data.

**Target Tenant ID:** `fd82da65-aab7-4a5c-85b8-b2febeb2003d`

## Migration Scripts

Located in `scripts/migrations/`:

| Script | Purpose |
|--------|---------|
| **migrate-tenant.js** | Main data migration - copies all table data with tenant_id |
| **migrate-credentials.js** | Credential migration - copies password hashes to new auth system |
| **fix-duplicate-members.mjs** | Cleanup - removes duplicate member records after migration |
| **discover-tables.js** | Utility to discover shared tables between databases |

## Complete Migration Process

The migration requires **two steps** run in sequence:

### Step 1: Migrate Data (migrate-tenant.js)

```bash
node scripts/migrations/migrate-tenant.js \
  --tenant-id=fd82da65-aab7-4a5c-85b8-b2febeb2003d \
  --source="postgresql://postgres.zkvgzcruhniduuswbfyh:PASSWORD@aws-1-eu-central-1.pooler.supabase.com:5432/postgres" \
  --dest="postgresql://postgres.lvmzliemqnieeoruhkik:PASSWORD@aws-1-eu-central-1.pooler.supabase.com:5432/postgres"
```

### Step 2: Migrate Credentials (migrate-credentials.js)

```bash
node scripts/migrations/migrate-credentials.js \
  --tenant-id=fd82da65-aab7-4a5c-85b8-b2febeb2003d \
  --dest="postgresql://postgres.lvmzliemqnieeoruhkik:PASSWORD@aws-1-eu-central-1.pooler.supabase.com:5432/postgres"
```

### Step 3: Fix Duplicates (if destination had existing data)

If the destination database had existing members before migration, you may have duplicate records. Run:

```bash
node scripts/migrations/fix-duplicate-members.mjs \
  --tenant-id=fd82da65-aab7-4a5c-85b8-b2febeb2003d \
  --dest="postgresql://postgres.lvmzliemqnieeoruhkik:PASSWORD@aws-1-eu-central-1.pooler.supabase.com:5432/postgres" \
  --dry-run
```

Remove `--dry-run` to apply the fix.

## Troubleshooting

### "Results contain 2 rows" / Browser crash on tenant subdomain

This error occurs when there are duplicate member records sharing the same `identity_id`. Symptoms:
- `PGRST116: Results contain 2 rows, application/vnd.pgrst.object+json requires 1 row`
- Browser tab crashes when loading tenant portal

**Fix:** Run the `fix-duplicate-members.mjs` script to remove duplicate member records.

### Foreign Key Violations
If child tables fail with FK errors, migrate parent tables first using `--tables=organization,member`.

### Duplicate Key Errors on system_settings
The script uses `setting_key` as conflict key since it has a global unique constraint.

# External Dependencies

-   **Supabase:** Primary database (PostgreSQL) and file storage.
-   **Stripe:** Payment processing.
-   **Xero:** Invoice generation.
-   **Microsoft Graph API:** Outlook email integration.
-   **Mailgun:** Tenant-specific email sending domains and email delivery.