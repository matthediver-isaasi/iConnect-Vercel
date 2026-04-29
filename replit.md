# Overview
This project is a multi-tenant SaaS platform for comprehensive membership management, unifying member, event, booking, resource, and blog post management. It features a unified identity system, dynamic page builder, custom forms with workflow automation, and a robust Due Diligence process. The platform supports a three-tier hierarchy (TENANT, ORGANIZATION, MEMBER) for access control and data isolation, aiming to streamline operations for organizations while offering advanced customization and automation capabilities. Key ambitions include providing a versatile platform for various organizational types, enhancing user engagement through personalized experiences, and simplifying complex administrative tasks.

# User Preferences
Preferred communication style: Simple, everyday language.

# System Architecture
The frontend is built with React 18 (TypeScript/JSX), Vite, TanStack Query, shadcn/ui (Radix UI), and Tailwind CSS, utilizing a custom "new-york" design system. The backend uses Express.js, PostgreSQL, and Drizzle ORM, with API endpoints deployed as Vercel serverless functions.

## Multi-Tenant Architecture
Data isolation is enforced across GLOBAL, TENANT, ORGANIZATION, and MEMBER levels using `tenant_id` and `organization_id`. The application is deployed on Vercel, using `iconn.app` for tenant owner management and `{tenant}.iconn.app` for member portals, facilitated by a tenant resolver for domain-to-tenant mapping.

## Identity and Access Management
A unified identity system manages user authentication, multi-tenant ownership, and organization memberships, including per-tenant password isolation, Google OAuth, and feature-based role management for granular control over UI visibility, backend access, and field access.

## Key Features
-   **Core Data Model:** Includes Member, Organization, Role, and TeamMember entities.
-   **Content Management:** Features event/booking management, general content management, a dynamic page builder, custom forms with conditional logic and uniqueness validation, and blog posts.
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
-   **Complex Events Module:** Multi-track events (conferences, courses) with separate entities for ComplexEvent, ComplexEventTrack, ComplexEventSession, and ComplexEventTicketClass.
-   **Booking Cancellation and Transfer Requests:** Members and admins can initiate cancellation or transfer requests for tickets or groups, which go through an admin review queue.
-   **Complex Event Sessions with Zoom Integration:** Multi-session events support individual sessions with per-session Zoom meeting/webinar integration, including auto-registration for attendees.
-   **Discount Codes:** Supports targeting discounts by organization, member, role, or member group, with per-member usage tracking and event restrictions.
-   **Zoom Attendance Tracking:** Fetches participant data from Zoom Reports API post-event, matches to bookings, and displays attendance status in reports with CSV export.
-   **Event-Linked Resource Access:** Resources can be linked to events/sessions, restricting access to members with confirmed bookings.
-   **Organization Directory Type Filter:** Allows filtering visible organizations based on their type.
-   **CRM Tags:** Free-text tagging on Organisation and Member records with a tag management page.
-   **Article Brief Management:** Admin-configurable workflow stages, brief categories, email notifications, and support for external writers.
-   **Case Study Uploads:** Supports versioned image/document uploads for article briefs from internal teams and external providers via token-authenticated public pages.
-   **Brief Copyright Assignment Form:** Workflow for collecting copyright assignment from writers, with configurable templates and tracking.
-   **Brief Send Email Templates:** Allows editors to select tenant-scoped email templates for Case Study Permission form sends and Copyright Assignment sends, supporting placeholders.
-   **Zoho Inbound Update Toast:** Provides real-time notifications via toast messages on detail pages when an organization or member record is updated by an inbound Zoho sync.
-   **External Writers:** Dedicated management for external (non-member) writers for article briefs, including CRUD operations, email validation, and NDA document uploads.
-   **Brief Management Inbox:** Tenant-scoped pseudo-inbox on `/BriefManagement` to surface case-study Permission/Copyright form submissions and attached files against existing briefs.
-   **LMIC Country Settings & Default Dashboard Widgets:** Per-tenant World Bank LMIC country list (admin page at `/admin/lmic-countries`, table `tenant_lmic_country`) seeded on first read. Dashboard widget builder gains an "LMIC only" filter operator that resolves to the saved list at query time, plus a `count_distinct` aggregator and time-bucket support for custom date fields. Widget measures support `additionalFields` (per-row sum across multiple fields) and a new `fifth` width (`md:col-span-2`) for 5-card top rows. `scripts/seed-default-dashboard-widgets.mjs` ensures the required custom fields exist (region, org_type, total_schools, children_impacted_direct, children_impacted_indirect, member.go_live) and idempotently seeds shared dashboard widgets for a given `TENANT_ID`.
-   **Due Diligence Reports:** Per-form analytics page (`/DueDiligenceReports`) with 4 cards (Application Funnel, Verification, DD Meetings, Decisions) sourcing `workflow_status`/score/risk from `form_submission_due_diligence` and deriving stage-transition timestamps from `history_log`. Supports form selector, period filters incl. custom date range, per-card SLA inputs, drill-through links to `DueDiligenceDashboard` (status/riskLevel/reviewer/outstandingDays URL params), CSV export per card, and a Funnel/Bar chart toggle. Includes monthly throughput, risk-level distribution, score-vs-outcome, reviewer breakdown, per-document stats, and real meeting metrics (booked/cancelled/no-show/rescheduled/lead-time) sourced from `dd_meeting_request` + `agent_booking`.

# External Dependencies
-   **Supabase:** PostgreSQL database and file storage.
-   **Stripe:** Payment processing.
-   **Xero:** Invoice generation.
-   **Microsoft Graph API:** Outlook email integration.
-   **Mailgun:** Tenant-specific email sending, delivery, and native Email Marketing System (EMS).
-   **Zoho Campaigns:** Syncing member communication preferences.