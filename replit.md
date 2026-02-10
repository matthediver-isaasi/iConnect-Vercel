# Overview
This project is a multi-tenant SaaS membership management platform designed to provide organizations with a comprehensive solution for managing members, events, bookings, resources, and blog posts. Its core purpose is to consolidate various organizational management functions into a single, efficient platform. Key capabilities include a unified identity system, a dynamic page builder, custom forms, workflow automation, and a robust Due Diligence process. The platform supports a three-tier hierarchy (TENANT, ORGANIZATION, MEMBER) with strong access control and data isolation, offering significant market potential for streamlining organizational operations.

# User Preferences
Preferred communication style: Simple, everyday language.

# System Architecture
## Core Technologies
The frontend is built with React 18 (TypeScript/JSX), Vite, TanStack Query, shadcn/ui (Radix UI), and Tailwind CSS. The backend uses Express.js, PostgreSQL, and Drizzle ORM. All API endpoints are deployed as Vercel serverless functions.

## Multi-Tenant Architecture
The platform features a multi-tenant design ensuring data isolation across GLOBAL, TENANT, ORGANIZATION, and MEMBER levels, primarily using `tenant_id` and `organization_id` for scoping.

## API Authentication Pattern
The platform supports two types of authenticated sessions: Member sessions (portal users) and Tenant user sessions (admin dashboard users). `getTenantContext(req)` is used for handling both session types.

## Identity and Access Management
A unified identity system manages user authentication, supporting multiple tenant ownership and organization memberships with per-tenant password isolation and Google OAuth. A feature-based role management system provides granular control over UI visibility and backend access, including protected system roles and role-based field access control.

## Deployment & Domain Structure
The application is deployed on Vercel, using `iconn.app` for tenant owner management and `{tenant}.iconn.app` for member portals, enabled by cross-subdomain session cookies.

## Tenant Resolver
The tenant resolver (`api/_lib/tenantResolver.js`) handles domain-to-tenant mapping for incoming requests and URL building for outgoing links. It includes functions like `resolveTenantFromHost(hostname)`, `resolveTenantFromRequest(req)`, and `getHostFromRequest(req)`. When building URLs for email links, `getHostFromRequest(req)` should be used to preserve the current environment.

## Key Features and Modules
-   **Core Data Model:** Includes Member, Organization, Role, and TeamMember entities.
-   **Content Management:** Event/booking management, general content management, dynamic page builder, custom forms with conditional logic, and blog posts.
-   **Communication:** Email template placeholder system and communication preferences management.
-   **Workflow Automation:** Tenant-scoped workflows for automating actions, including a Due Diligence process.
-   **Branding & Customization:** Per-tenant branding system for public-facing pages.
-   **Form Embedding:** Forms can be embedded on external websites via iFrame with a public API.
-   **Data Management:** Server-side pagination and a robust data migration system.
-   **Email Domain Provisioning:** Automated Mailgun domain provisioning for each tenant.
-   **Realtime Updates:** Supabase Realtime Subscriptions for frontend cache invalidation.
-   **Booking System:** Agent booking system with tenant-scoped meeting templates.
-   **Resource View Tracking:** Unique view tracking per user per resource on CTA click. Table: `resource_view` (mirrors `article_view` structure). View counts displayed on resource cards. Reports: `api/reports/resource-views-stats.js` provides total views, unique resources/viewers, period comparisons, views-by-type breakdown (Download/Video/URL), and top resources. Integrated into `ReportsDashboard.jsx` as a draggable report card with demo mode support. Entity registered in `entitiesWithoutOrgId` lists (tenant-scoped, no org_id).
-   **Organisation Membership Tab:** Per-organisation membership tier view showing current tier, editable control variable, next year fee preview with rollover discount, and historical fee records. Supports renewal overrides (structure or manual price) via `api/membership/org-membership-override.js` with mandatory notes for audit trail stored in `organisation_membership_override` table. Includes invoicing options (Automatic/Scheduled/Manual) per organisation stored in `organisation_membership_invoicing` table. Manual mode provides "Renew & Invoice Now" button. API: `api/membership/org-membership-invoicing.js`. Init: `api/admin/init-membership-invoicing-table.js`.

-   **Fundraising Module:** Tenant-scoped fundraising campaigns with team members (internal or external), unique donation page links per team member, Stripe payment processing, UK Gift Aid capture (address fields + HMRC declaration). Public donation pages are embeddable via iframe. Admin: `api/fundraising/campaigns.js`, `api/fundraising/team-members.js`, `api/fundraising/donations.js`. Public: `api/public/fundraising/[token].js`, `api/public/fundraising/donate.js`, `api/public/fundraising/confirm-donation.js`. Frontend: `FundraisingManagement.jsx` (admin), `DonatePage.jsx` (public). Tables: `fundraising_campaign`, `fundraising_team_member`, `fundraising_donation`. Init: `api/admin/init-fundraising-tables.js`.

-   **Bookmarking System:** Member bookmarks for blog posts, news posts, events, resources, and forum threads. Stored in `member_bookmark` table with `sort_order` for per-item ordering. Category section order stored in `member_bookmark_preferences` table (`category_order` JSONB). Drawer UI supports drag-and-drop reordering of both categories and items within categories via @dnd-kit. APIs: `api/bookmarks/index.js` (CRUD), `api/bookmarks/enriched.js` (enriched with entity data + category order), `api/bookmarks/reorder.js` (category and item reorder). Frontend: `BookmarkDrawer.jsx` (drawer), `BookmarkButton.jsx` (toggle), `useBookmarks.js` (hook). Init: `api/admin/init-bookmark-tables.js`. Sheet component extended with `hideClose` prop.

-   **Forum Module:** Tenant-scoped discussion forums with role-managed access control. Supports open categories (visible to all members) and group-linked categories (restricted to specific MemberGroup members). Features: threaded discussions with collapsible nested replies, thumbs up/down dual reactions (matching article reaction style), category header images with focal point control, content reporting, and full moderation suite (pin/unpin, lock/unlock, move threads, hide/unhide posts, "Go to latest" scroll) with audit logging to `forum_moderation_log`. **Soft delete:** Posts with replies are soft-deleted (`is_deleted=true`, content replaced with '[Deleted]') preserving reply tree structure; posts without replies are hard-deleted; orphaned soft-deleted parents are auto-cleaned when their last child is removed. Delete API: `api/forum/delete-post.js`. Admin: `ForumManagement.jsx` (category CRUD, report management, moderation log). Member: `Forum.jsx` (browse categories/threads), `ForumThread.jsx` (view/reply/react). Tables: `forum_category`, `forum_thread`, `forum_post` (includes `is_deleted` column), `forum_reaction`, `forum_report`, `forum_moderation_log`. Init: `api/admin/init-forum-tables.js`. Moderation API: `api/forum/moderate.js`. Entities use `tenant_id` only (no org scoping).

## Event Timezone Handling
Events store times in UTC with a separate `timezone` field for display purposes. Display logic prioritizes Zoom event timezones, then `event.timezone`, falling back to `'Europe/London'`. Time formatting utilities are provided in `client/src/utils/timeFormat.js`.

## Membership Tier System
The platform supports membership pricing based on organisation attributes with historical versioning. The `membership_tier_config` table stores tier configurations (field to base tiers on, currency, billing period, `effective_from`, `effective_to`) and `membership_tier_band` stores individual bands. Each tenant can have multiple configs over time, with the current config having `effective_to = null`. The system supports both core fields and custom numerical organisation fields from `preference_field`.

### Pro-rata Pricing Logic
The membership tier system supports pro-rata pricing based on `membership_start_month`, `membership_start_day`, `prorata_enabled`, `free_period_amount`, `free_period_unit`, and `rollover_enabled`.
-   **Pro-rata Calculation:** If enabled, the annual fee is prorated based on remaining days in the membership year.
-   **Free Period Logic:** A configured free period is deducted from the annual fee.
-   **Rollover Logic:** If enabled, unused free months from the free period carry forward to reduce the *next* full year's fee, but do not cascade beyond one year. The free period is always deducted from the annual fee.

## UI/UX
The frontend uses a custom "new-york" design system, leveraging shadcn/ui (Radix UI) and Tailwind CSS for a consistent and responsive user experience, including a collapsible sidebar.

# External Dependencies
-   **Supabase:** Primary database (PostgreSQL) and file storage.
-   **Stripe:** Payment processing.
-   **Xero:** Invoice generation.
-   **Microsoft Graph API:** Outlook email integration.
-   **Mailgun:** Tenant-specific email sending domains, email delivery, and a native Email Marketing System (EMS) with full tracking capabilities.
-   **Zoho Campaigns:** Integrations for syncing member communication preferences.