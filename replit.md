# Overview
This project is a multi-tenant SaaS platform for comprehensive membership management, unifying member, event, booking, resource, and blog post management. It features a unified identity system, dynamic page builder, custom forms with workflow automation, and a robust Due Diligence process. The platform supports a three-tier hierarchy (TENANT, ORGANIZATION, MEMBER) for access control and data isolation, aiming to streamline operations for organizations.

# User Preferences
Preferred communication style: Simple, everyday language.

# System Architecture
The frontend is built with React 18 (TypeScript/JSX), Vite, TanStack Query, shadcn/ui (Radix UI), and Tailwind CSS. The backend uses Express.js, PostgreSQL, and Drizzle ORM, with API endpoints deployed as Vercel serverless functions.

## Multi-Tenant Architecture
Data isolation is enforced across GLOBAL, TENANT, ORGANIZATION, and MEMBER levels using `tenant_id` and `organization_id`. API authentication supports both Member (portal) and Tenant user (admin dashboard) sessions.

## Identity and Access Management
A unified identity system manages user authentication, multi-tenant ownership, and organization memberships. It includes per-tenant password isolation, Google OAuth, and feature-based role management for granular control over UI visibility, backend access, and field access.

## Deployment & Domain Structure
The application is deployed on Vercel, using `iconn.app` for tenant owner management and `{tenant}.iconn.app` for member portals, with a tenant resolver for domain-to-tenant mapping.

## Key Features
-   **Core Data Model:** Includes Member, Organization, Role, and TeamMember entities.
-   **Content Management:** Features event/booking management (with phone, Zoom, Microsoft Teams, and in-person meeting types), general content management, a dynamic page builder with advanced timeline elements, custom forms with conditional logic and uniqueness validation, and blog posts.
-   **Membership Payment:** Integrates Stripe for membership fees, supporting auto-submission, year 2 rollover logic, Xero invoice attachment, and configurable invoice address sourcing.
-   **Communication:** Includes an email template system, communication preferences, and email campaigns with list-based targeting.
-   **Workflow Automation:** Provides tenant-scoped workflows for automating actions like sending emails, updating fields, and managing memberships.
-   **Field Visibility Rules:** Implements conditional show/hide rules for fields and cards on organisation and member detail views, with role-based read/write control and drag-and-drop reordering.
-   **Branding & Customization:** Supports per-tenant branding for public-facing pages and embeddable forms.
-   **Fundraising Module:** Supports tenant-scoped campaigns with donation pages, Stripe processing, UK Gift Aid, and AI-suggested content.
-   **Dynamic Directory:** Configurable member/organisation directories with slug-based URLs, server-side filtering, and field visibility settings.
-   **Forum Module:** Provides tenant-scoped discussion forums with role-managed access.
-   **Membership Tier System:** Supports pricing based on organization or member attributes with historical versioning, multi-structure support, configurable discounts, pro-rata pricing, and cron-based renewals.
-   **Booking Cancellation Requests:** Members can request cancellation of individual tickets or entire booking groups from the /Bookings page. Requests go to an admin review queue (CancellationRequests admin page) where they can be approved or rejected. Approval automatically cancels the booking and handles: training fund/voucher/discount code reversal with expired-item replacement (Phase 1), Stripe partial refunds with idempotency (Phase 2), and Xero credit note creation with allocation against original invoice (Phase 3). Credit note ID/number stored on `booking` table (`xero_credit_note_id`, `xero_credit_note_number`). Members can view/download credit note PDFs from /Bookings (orange card, mirrors invoice card). Uses `booking_cancellation_request` table. API: `api/booking-cancellation-requests/`, `api/booking-credit-note/`.
-   **Booking Transfer Requests:** Members can request transferring individual tickets to another member within the same organisation and role from /Bookings or /MyTickets. Transfers go through admin review (same admin page as cancellations, with type filter). No financial implications — just an attendee swap (email, first_name, last_name, member_id). On approval: original attendee notified (no recipient name), new attendee gets registration confirmation. On rejection: requester notified with review notes. Uses `booking_transfer_request` table. API: `api/booking-transfer-requests/` (index.js for create/list, [requestId].js for approve/reject, eligible-members.js for same-org+role member search). Frontend: `TransferTicketDialog.jsx` shared component.

## UI/UX
The frontend employs a custom "new-york" design system, leveraging shadcn/ui (Radix UI) and Tailwind CSS for a consistent, responsive user experience with a collapsible sidebar.

# External Dependencies
-   **Supabase:** PostgreSQL database and file storage.
-   **Stripe:** Payment processing, supporting per-feature test/live mode switching.
-   **Xero:** Invoice generation.
-   **Microsoft Graph API:** Outlook email integration with background cron-based sync.
-   **Mailgun:** Tenant-specific email sending, delivery, and native Email Marketing System (EMS).
-   **Zoho Campaigns:** Syncing member communication preferences.

## Outlook Background Email Sync
A Vercel cron job (`api/cron/sync-outlook-emails.js`) runs every 5 minutes, checking all active `outlook_connection` records. For each connection, it compares `last_sync_at` against the tenant's configured `outlook_sync_frequency_minutes` system setting (default: 15 min). Eligible connections are synced using the shared helper `api/_lib/outlookSync.js` (token refresh, Graph API email fetch, member matching, upsert to `member_email`). Results are logged to `scheduled_task_log`. The frequency is configurable per-tenant from the Admin Integrations page (`api/admin/outlook-sync-settings.js`). The manual sync endpoint `api/outlook/sync.js` also uses the shared helper.

## Database Connection Instructions
⚠️ NEVER REMOVE THIS SECTION - These instructions are essential for database access ⚠️

This project uses Supabase PostgreSQL databases. Direct psql commands and execute_sql_tool DO NOT WORK on Replit due to IPv6 connectivity issues.

### Available Database Secrets
| Secret | Database | Purpose |
|--------|----------|---------|
| SOURCE_DATABASE_URL | Legacy single-tenant Supabase | Original data source for migrations |
| DEST_DATABASE_URL | New multi-tenant Supabase | Production destination database |
| DEST_SUPABASE_KEY | New multi-tenant Supabase | Service role key for Supabase client |

### How to Query the Database
USE NODE.JS SCRIPTS - NOT psql or execute_sql_tool

```javascript
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://lvmzliemqnieeoruhkik.supabase.co';
const supabaseKey = process.env.DEST_SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const { data, error } = await supabase
  .from('member')
  .select('*')
  .eq('tenant_id', 'fd82da65-aab7-4a5c-85b8-b2febeb2003d')
  .limit(10);
```

Run with: `node scripts/debug-query.mjs` or inline with `node -e "..."`

### Important Notes
- Replit's built-in database tools won't work due to IPv6 routing issues
- Always use Supabase client (`@supabase/supabase-js`) or pg client with `DEST_DATABASE_URL`
- Tenant ID for GFI: `fd82da65-aab7-4a5c-85b8-b2febeb2003d`

## Organisation Directory Type Filter
Organisation Directory Settings (`OrganisationDirectorySettings.jsx`) supports a "Visible Organisation Types" filter via the `org_directory_visible_org_types` system setting (JSON array of type values). When non-empty, only organisations whose `org_type`/`organisation_type`/`organization_type` preference field value matches one of the selected types are shown. Empty = show all (backward compatible). Both `OrganisationDirectory.jsx` and `IEditOrganisationDirectoryElement.jsx` (page builder) respect this filter. The settings and directory pages use separate TanStack Query keys (`organisation-directory-settings-admin` vs `organisation-directory-settings`) to avoid cache collisions.