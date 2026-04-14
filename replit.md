# Overview
This project is a multi-tenant SaaS platform for comprehensive membership management, unifying member, event, booking, resource, and blog post management. It features a unified identity system, dynamic page builder, custom forms with workflow automation, and a robust Due Diligence process. The platform supports a three-tier hierarchy (TENANT, ORGANIZATION, MEMBER) for access control and data isolation, aiming to streamline operations for organizations while offering advanced customization and automation capabilities. Key ambitions include providing a versatile platform for various organizational types, enhancing user engagement through personalized experiences, and simplifying complex administrative tasks.

# User Preferences
Preferred communication style: Simple, everyday language.

# System Architecture
The frontend is built with React 18 (TypeScript/JSX), Vite, TanStack Query, shadcn/ui (Radix UI), and Tailwind CSS, utilizing a custom "new-york" design system for a consistent and responsive user experience. The backend uses Express.js, PostgreSQL, and Drizzle ORM, with API endpoints deployed as Vercel serverless functions.

## Multi-Tenant Architecture
Data isolation is enforced across GLOBAL, TENANT, ORGANIZATION, and MEMBER levels using `tenant_id` and `organization_id`. The application is deployed on Vercel, using `iconn.app` for tenant owner management and `{tenant}.iconn.app` for member portals, facilitated by a tenant resolver for domain-to-tenant mapping.

## Identity and Access Management
A unified identity system manages user authentication, multi-tenant ownership, and organization memberships, including per-tenant password isolation, Google OAuth, and feature-based role management for granular control over UI visibility, backend access, and field access.

## Key Features
-   **Core Data Model:** Includes Member, Organization, Role, and TeamMember entities.
-   **Content Management:** Features event/booking management, general content management, a dynamic page builder, custom forms with conditional logic and uniqueness validation, and blog posts. Forms support prefill from Member Data, Organisation Data, and Event Attendee (Booking), and a "Name Badge" page style for printing.
-   **Membership Payment:** Integrates Stripe for membership fees, supporting auto-submission, year 2 rollover logic, Xero invoice attachment, and configurable invoice address sourcing.
-   **Communication:** Includes an email template system, communication preferences, and email campaigns with list-based targeting.
-   **Workflow Automation:** Provides tenant-scoped workflows for automating actions.
-   **Field Visibility Rules:** Implements conditional show/hide rules for fields and cards, with role-based read/write control.
-   **Branding & Customization:** Supports per-tenant branding for public-facing pages and embeddable forms.
-   **Fundraising Module:** Supports tenant-scoped campaigns with donation pages, Stripe processing, and UK Gift Aid.
-   **Dynamic Directory:** Configurable member/organisation directories with filtering and field visibility settings.
-   **WordPress Sync:** iConnect articles sync to WordPress sites via a dedicated plugin and webhook system.
-   **Forum Module:** Provides tenant-scoped discussion forums with role-managed access, image attachments, and real-time subscriptions.
-   **Membership Tier System:** Supports pricing based on organization or member attributes with historical versioning, pro-rata pricing, and cron-based renewals.
-   **Complex Events Module:** Multi-track events (conferences, courses) with separate entities for ComplexEvent, ComplexEventTrack, ComplexEventSession, and ComplexEventTicketClass. Ticket classes support track-based access control (linked to specific tracks or all tracks), early bird pricing, group tickets, VAT configuration, visibility modes, and role restrictions. Real-time ticket availability tracking mirrors the simple event pattern.
-   **Booking Cancellation Requests:** Members and admins can initiate cancellation requests for tickets or groups, which go through an admin review queue. Approved cancellations handle Stripe refunds and Xero credit note creation.
-   **Booking Transfer Requests:** Members and admins can initiate ticket transfer requests within the same organization, subject to admin review. Transfers update attendee details and Xero invoice line items where applicable. Supports public/guest ticket transfers via manual entry.
-   **Complex Event Sessions:** Multi-session (complex) events support individual sessions with per-session Zoom meeting/webinar integration. Each virtual/hybrid session can have its own Zoom link, host, and registration settings. Sessions are stored in the `complex_event_session` table. Booking confirmation auto-registers attendees for Zoom webinar sessions. Session schedules with join links (for booked attendees) are displayed on the public event detail page.
-   **Discount Codes:** Supports targeting discounts by organization, member, role, or member group, with per-member usage tracking. Discount codes can also be restricted to specific events.
-   **Zoom Attendance Tracking:** After Zoom meetings/webinars end, participant data is fetched from the Zoom Reports API and stored in `zoom_attendance` table. Participants are matched to bookings by email. The Event Registration Report shows an "Attended" column (Yes/Partial/No) with tooltips showing join/leave times and duration. CSV export includes attendance data. Admins can manually trigger "Sync Attendance" from the report. An auto-sync endpoint (`/api/zoom/attendance-auto-sync`) identifies ended meetings needing sync. Works for both standard events and complex event sessions.
-   **Event-Linked Resource Access:** Resources can be linked to one or more events (and optionally specific sessions within complex events). Only members with a confirmed booking for at least one linked event/session can see the resource. Session-level linking checks track access via ticket class. Admin form has a "Linked Events" section for managing links. Public API excludes event-linked resources. Uses `linked_events` JSONB column on resource table and `api/resources/check-event-access.js` endpoint.
-   **Organization Directory Type Filter:** Allows filtering visible organizations in the directory based on their type.
-   **CRM Tags:** Free-text tagging on Organisation and Member records (stored as `text[]` columns). Tag Management page supports four sections (Resources, Articles, Organisations, Members) with rename and delete for all tag types.
-   **Article Brief Settings:** Admin-configurable workflow stages, brief categories, and email notification toggles per tenant. Stored in `article_brief_settings` table (JSONB stages/categories, boolean notify flags). BriefManagement and BriefDetail pages read stages dynamically instead of using hardcoded STATUS_CONFIG. Category field uses a dropdown populated from configured categories. Email notifications are sent via Mailgun on key events (writer assigned, status changes, comments, version uploads).

# External Dependencies
-   **Supabase:** PostgreSQL database and file storage.
-   **Stripe:** Payment processing.
-   **Xero:** Invoice generation.
-   **Microsoft Graph API:** Outlook email integration with background cron-based sync.
-   **Mailgun:** Tenant-specific email sending, delivery, and native Email Marketing System (EMS).
-   **Zoho Campaigns:** Syncing member communication preferences.

## Database Connection Instructions
This project uses Supabase PostgreSQL databases. Direct psql commands and `execute_sql_tool` DO NOT WORK on Replit due to IPv6 connectivity issues.

### Available Database Secrets
| Secret | Database | Purpose |
|--------|----------|---------|
| SOURCE_DATABASE_URL | Legacy single-tenant Supabase | Original data source for migrations |
| DEST_DATABASE_URL | New multi-tenant Supabase | Production destination database |
| DEST_SUPABASE_KEY | New multi-tenant Supabase | Service role key for Supabase client |

### How to Query the Database
USE NODE.JS SCRIPTS with the Supabase client (`@supabase/supabase-js`) or a `pg` client with `DEST_DATABASE_URL`.