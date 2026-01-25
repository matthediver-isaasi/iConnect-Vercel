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

# Database Environment

## Development Database (DEST_DATABASE_URL)

The agent can connect directly to the Supabase PostgreSQL database using the pooler connection. This is the new multi-tenant development database.

- **Secret Name:** `DEST_DATABASE_URL`
- **Host:** `aws-1-eu-central-1.pooler.supabase.com`
- **Project:** `lvmzliemqnieeoruhkik`
- **Database:** PostgreSQL via Supabase pooler connection
- **Purpose:** Multi-tenant development/staging environment

The agent can run SQL queries, inspect schema, and debug data issues directly against this database using Node.js pg client with SSL enabled.

## Source Database (SOURCE_DATABASE_URL)

The legacy single-tenant Supabase database being migrated from.

- **Secret Name:** `SOURCE_DATABASE_URL`
- **Host:** `aws-1-eu-central-1.pooler.supabase.com`
- **Project:** `zkvgzcruhniduuswbfyh`
- **Database:** PostgreSQL via Supabase pooler connection
- **Purpose:** Legacy single-tenant production data (read-only for migration)

## Connecting to Databases

Both databases are accessible via Supabase pooler connections. Use Node.js with the `pg` package:

```javascript
const pg = require('pg');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // Required for Supabase pooler

const client = new pg.Client({
  connectionString: process.env.DEST_DATABASE_URL, // or SOURCE_DATABASE_URL
  ssl: true
});
await client.connect();
```

# Data Migration System

## Overview

A reusable migration solution transfers data from the legacy single-tenant Supabase database to the new multi-tenant application. The migration handles ~10,800 records across 80+ shared tables, adding `tenant_id` to all migrated data.

**Target Tenant ID:** `fd82da65-aab7-4a5c-85b8-b2febeb2003d`

## Migration Scripts

Located in `scripts/migrations/`:

- **migrate-tenant.js** - Main migration script with upsert logic
- **discover-tables.js** - Discovers shared tables between source and destination

## Running the Full Migration

```bash
node scripts/migrations/migrate-tenant.js \
  --tenant-id=fd82da65-aab7-4a5c-85b8-b2febeb2003d \
  --source="postgresql://postgres.zkvgzcruhniduuswbfyh:PASSWORD@aws-1-eu-central-1.pooler.supabase.com:5432/postgres" \
  --dest="postgresql://postgres.lvmzliemqnieeoruhkik:PASSWORD@aws-1-eu-central-1.pooler.supabase.com:5432/postgres"
```

## Migration Options

| Option | Description |
|--------|-------------|
| `--tenant-id=ID` | Required. Tenant ID to assign to migrated records |
| `--dry-run` | Preview migration without making changes |
| `--tables=t1,t2` | Migrate only specific tables (comma-separated) |
| `--source=URL` | Override SOURCE_DATABASE_URL |
| `--dest=URL` | Override DEST_DATABASE_URL |

## Examples

**Dry run to preview:**
```bash
node scripts/migrations/migrate-tenant.js \
  --tenant-id=fd82da65-aab7-4a5c-85b8-b2febeb2003d \
  --dry-run \
  --source="postgresql://..." \
  --dest="postgresql://..."
```

**Migrate specific tables:**
```bash
node scripts/migrations/migrate-tenant.js \
  --tenant-id=fd82da65-aab7-4a5c-85b8-b2febeb2003d \
  --tables=organization,member,organization_preference_value \
  --source="postgresql://..." \
  --dest="postgresql://..."
```

## Migration Features

- **Automatic dependency ordering:** Tables are migrated in FK dependency order
- **Upsert logic:** Uses `ON CONFLICT ... DO UPDATE` for safe re-runs
- **JSONB handling:** Correctly serializes JSONB columns while preserving native PostgreSQL arrays
- **Field type mapping:** Transforms legacy field types (list→dropdown, picklist→dropdown, url→text)
- **Composite key support:** Handles tables with unique constraints on multiple columns

## Special Table Handling

| Table | Conflict Key | Notes |
|-------|--------------|-------|
| `system_settings` | `setting_key` | Has global unique constraint on setting_key |
| Other tables | `id` | Standard primary key upsert |

## Cutover Checklist

Before final production cutover:

1. **Verify source data is stable** - Ensure no active writes to legacy system
2. **Run full migration:**
   ```bash
   node scripts/migrations/migrate-tenant.js \
     --tenant-id=fd82da65-aab7-4a5c-85b8-b2febeb2003d \
     --source="..." --dest="..."
   ```
3. **Verify row counts match:**
   ```bash
   node scripts/migrations/discover-tables.js
   ```
4. **Spot check critical data** - Verify organizations, members, preference values
5. **Update DNS/routing** - Point traffic to new multi-tenant system
6. **Disable legacy system writes** - Mark as read-only

## Credential Migration

The multi-tenant system uses a different authentication architecture than the single-tenant system. After migrating member data, you must also migrate credentials to enable member login.

**migrate-credentials.js** - Migrates password hashes from `member_credentials` to the new auth tables:
- Creates `tenant_identity` records for each unique email
- Creates `tenant_membership_credentials` linking identity to tenant
- Updates `member.identity_id` to link members to their identity

```bash
node scripts/migrations/migrate-credentials.js \
  --tenant-id=fd82da65-aab7-4a5c-85b8-b2febeb2003d \
  --dest="postgresql://postgres.lvmzliemqnieeoruhkik:PASSWORD@aws-1-eu-central-1.pooler.supabase.com:5432/postgres"
```

Options:
- `--tenant-id=ID` - Required. Tenant ID to migrate credentials for
- `--dry-run` - Preview without making changes
- `--dest=URL` - Override DEST_DATABASE_URL

The script is idempotent and can be run multiple times safely.

**Note:** The `tenant_identity` table uses email as a global unique identifier (by design - one person can belong to multiple tenants). The `tenant_membership_credentials` table provides per-tenant password isolation. For users who belong to multiple tenants, they share one identity but have separate credentials per tenant.

## Troubleshooting

### Foreign Key Violations
If child tables fail with FK errors, migrate parent tables first:
```bash
node scripts/migrations/migrate-tenant.js \
  --tenant-id=... --tables=organization,member \
  --source="..." --dest="..."
```

### Duplicate Key Errors on system_settings
The script uses `setting_key` as conflict key since it has a global unique constraint.

### JSONB Array Issues
The script distinguishes between JSONB columns (which need JSON.stringify) and native PostgreSQL arrays (which don't) using column metadata.

# External Dependencies

- **Supabase:** Primary database (PostgreSQL) and file storage.
- **Stripe:** Payment processing.
- **Xero:** Invoice generation.
- **Microsoft Graph API:** Outlook email integration.
- **Mailgun:** Tenant-specific email sending domains and email delivery.