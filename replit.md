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
-   **Content Management:** Features event/booking management (with phone, Zoom, Microsoft Teams, and in-person meeting types), general content management, a dynamic page builder with advanced timeline elements, custom forms with conditional logic and uniqueness validation, and blog posts. Forms support three prefill sources: Member Data, Organisation Data, and Event Attendee (Booking). Booking prefill (`?booking_id=xxx`) populates from attendee fields (name, email, phone, job title, guest org name, event name, ticket class, booking reference) with automatic fallback to linked member and organisation data. API: `api/public/form/prefill-booking.js`. Forms support a **Name Badge** page style (`page_style: "name_badge"` on form pages). When a page has this style, its fields render inside a badge-shaped visual container (configurable accent/background/border colours, width, height) instead of the standard Card layout. Fields use the existing column system and standard field types. Print via browser print API. Config stored on the page object (`badge_style`). The old `name_card` field type and `NameCardBadge.jsx` component have been removed.
-   **Membership Payment:** Integrates Stripe for membership fees, supporting auto-submission, year 2 rollover logic, Xero invoice attachment, and configurable invoice address sourcing.
-   **Communication:** Includes an email template system, communication preferences, and email campaigns with list-based targeting.
-   **Workflow Automation:** Provides tenant-scoped workflows for automating actions like sending emails, updating fields, and managing memberships.
-   **Field Visibility Rules:** Implements conditional show/hide rules for fields and cards on organisation and member detail views, with role-based read/write control and drag-and-drop reordering.
-   **Branding & Customization:** Supports per-tenant branding for public-facing pages and embeddable forms.
-   **Fundraising Module:** Supports tenant-scoped campaigns with donation pages, Stripe processing, UK Gift Aid, and AI-suggested content.
-   **Dynamic Directory:** Configurable member/organisation directories with slug-based URLs, server-side filtering, and field visibility settings.
-   **WordPress Sync:** iConnect articles sync to WordPress sites via the iConnect Content Sync plugin. Articles are served from `/api/public/articles` (tenant-scoped). When articles are created, updated, or deleted, a webhook notification is dispatched to the tenant's configured WordPress webhook URL (`wp_webhook_url` and `wp_webhook_api_key` system settings). Settings managed via `api/admin/wp-sync-settings.js` (admin-only). UI in Articles Settings page. Webhook dispatch helper: `api/_lib/wpWebhook.js` (fire-and-forget, non-blocking). Hooks into `BlogPost` entity create/update/delete in generic entity handlers.
-   **Forum Module:** Provides tenant-scoped discussion forums with role-managed access, image attachments on posts (uploaded to `public-assets` bucket under `{tenantId}/forum/`), responsive gallery display (1/2/grid layouts), lightbox preview, and real-time subscriptions for posts, threads, and reactions.
-   **Membership Tier System:** Supports pricing based on organization or member attributes with historical versioning, multi-structure support, configurable discounts, pro-rata pricing, and cron-based renewals.
-   **Booking Cancellation Requests:** Members can request cancellation of individual tickets or entire booking groups from the /Bookings page. Admins can also initiate cancellation requests from the /EventRegistrationReport page. Requests go to an admin review queue (CancellationRequests admin page) where they can be approved or rejected. Approval automatically cancels the booking and handles: training fund/voucher/discount code reversal with expired-item replacement (Phase 1), Stripe partial refunds with idempotency (Phase 2), and Xero credit note creation with allocation against original invoice (Phase 3). Credit note ID/number stored on `booking` table (`xero_credit_note_id`, `xero_credit_note_number`). Members can view/download credit note PDFs from /Bookings (orange card, mirrors invoice card). Uses `booking_cancellation_request` table. API: `api/booking-cancellation-requests/`, `api/booking-credit-note/`. The POST endpoint supports both member sessions and admin (tenant user) sessions — admin sessions bypass ownership checks but still enforce tenant scoping. **Group cancellation** ("Cancel All Tickets") creates a single cancellation request per ticket with `request_type='group'`. Admin approval uses consolidated endpoint (`api/booking-cancellation-requests/approve-group.js`) which processes one Stripe refund (sum of card amounts) and one Xero credit note (sum of total costs) across the whole group, with per-ticket training fund/program ticket reversals and per-group voucher/discount code reversals. Validates group integrity (same booking_group_reference, same org, single payment intent, single invoice). GET endpoint returns `groupFinancialSummary` for aggregated display.
-   **Booking Transfer Requests:** Members can request transferring individual tickets to another member within the same organisation from /Bookings or /MyTickets. Admins can also initiate transfer requests from the /EventRegistrationReport page. Role restriction is configurable via `transfer_restrict_by_role` system setting (default: true, matching same role). Toggle available in /EventSettings under "Ticket Transfer Settings". Transfers go through admin review (same admin page as cancellations, with type filter). No financial implications — just an attendee swap (email, first_name, last_name, member_id). On approval, if the booking has a linked Xero invoice (`xero_invoice_id`), the line item description is updated to replace the original attendee's name/email with the new attendee's details (exact line matching against the attendee list). Skips PAID/VOIDED invoices. Non-blocking (fire-and-forget with error logging). On approval: original attendee notified (no recipient name), new attendee gets registration confirmation. On rejection: requester notified with review notes. Uses `booking_transfer_request` table. API: `api/booking-transfer-requests/` (index.js for create/list, [requestId].js for approve/reject, eligible-members.js for same-org member search with optional role filter). Both POST and eligible-members endpoints support admin (tenant user) sessions — admin sessions bypass ownership checks. Frontend: `TransferTicketDialog.jsx` shared component.

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

## Discount Code Member Targeting
The `discount_code` table supports four target types beyond global: `organization_id` (existing), `member_id`, `role_id`, and `member_group_id`. These are mutually exclusive — only one targeting field can be set per code. The admin UI (`DiscountCodeManagement.jsx`) uses a radio group to select the target type: Global, Organisation, Individual Member, Role, or Member Group. Member search uses a debounced query to `/api/members/search`. Roles come from `/api/admin/roles`. Member groups come from the MemberGroup entity. Backend validation in `applyDiscountCode` checks member_id match, role_id match (via member table), and member_group_id membership (via `member_group_assignment` table). Member identity is derived server-side from authenticated session (not client-supplied). Per-member usage is tracked in `discount_code_usage` (with `member_id` column) for member/role/group-targeted codes. Max uses applies per individual member for these target types.

## Discount Code Event Targeting
The `discount_code` table has an optional `event_id` column (UUID, FK to `event`). When set, the code can only be used for that specific event. This is independent of `program_tag` and the member/org targeting — a code can have program, event, and target restrictions simultaneously. Admin UI shows an "Event (Optional)" dropdown alongside the "Program (Optional)" dropdown. Backend validates event restriction in both `applyDiscountCode` (rejects if `eventId` doesn't match) and `createOneOffEventBooking` (booking-time validation). Migration: `scripts/migrations/add-discount-code-event-id.mjs`.

## Organisation Directory Type Filter
Organisation Directory Settings (`OrganisationDirectorySettings.jsx`) supports a "Visible Organisation Types" filter via the `org_directory_visible_org_types` system setting (JSON array of type values). When non-empty, only organisations whose `org_type`/`organisation_type`/`organization_type` preference field value matches one of the selected types are shown. Empty = show all (backward compatible). Both `OrganisationDirectory.jsx` and `IEditOrganisationDirectoryElement.jsx` (page builder) respect this filter. The settings and directory pages use separate TanStack Query keys (`organisation-directory-settings-admin` vs `organisation-directory-settings`) to avoid cache collisions.