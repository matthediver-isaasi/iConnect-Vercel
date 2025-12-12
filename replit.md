# Overview
<!-- Last updated: 2024-12-11 CRM branch -->

This project is a membership management platform built with React (Vite) and Express.js. It manages members, organizations, events, bookings, program tickets, resources, and blog posts, along with administrative functions. The platform is migrating from Base44 to Replit, requiring 100% visual and functional parity. It integrates with Supabase for data, Zoho CRM for contact management, Zoho Backstage for events, Stripe for payments, and Xero for invoicing.

# User Preferences

Preferred communication style: Simple, everyday language.

# System Architecture

## Frontend Architecture

**Technology Stack:** React 18 (TypeScript/JSX), Vite, TanStack Query, shadcn/ui (Radix UI), Tailwind CSS.
**Design System:** Uses a customized "new-york" style from shadcn/ui, requiring pixel-perfect visual and functional parity with the Base44 version.
**Routing:** Client-side routing with all routes falling through to `index.html` for SPA behavior, except `/api/*` routes which go to the backend.

## Backend Architecture

**Server Framework:** Express.js with separate development and production entry points.
**Database Layer:** PostgreSQL via Neon serverless, using Drizzle ORM.
**API Design Pattern:** Generic entity CRUD API mirroring the Base44 SDK for common operations (GET, POST, PATCH, DELETE).
**Authentication:** Password-based authentication with server-side session management using `express-session`, including endpoints for login, logout, password management, and user session retrieval (`/api/auth/me`).
**Admin Security Model:** Role-based access control for admin-only operations, verifying permissions via session and `verifyPermission()` helper. Frontend uses `useServerAdminAuth` for permission checks.
**Function Handlers:** Server-side functions for specific operations like magic link generation, Stripe payments, bookings, and event synchronization.

## Data Model

**Core Entities:** Member, Organization, Role, TeamMember, supporting various relationships.
**Role Segmentation:** Roles can be segmented by an organisation custom field (e.g., "Organisation Type"). When enabled via the role_segmentation_field_id system setting, default roles filter by organisation's preference value matching the role's segment_values array. This allows different organisation types to receive different default roles on member creation/login.
**Events & Bookings:** Manages Event (synced from Zoho Backstage or one-off), Booking, Program, and ProgramTicketTransaction. One-off events support direct pricing and role-based ticket classes with options for public visibility, BOGO, and bulk discounts. Events include `summary` and rich-text `description` fields. Guest checkout is supported for public tickets, capturing guest information and processing Stripe payments.
**Content Management:** Includes BlogPost, Resource, NewsPost, and a dynamic page builder (IEditPage/IEditPageElement).
**Typography System:** Pre-defined typography styles can be applied to elements in the page builder, with responsive mobile sizing and manual font settings.
**Forms System:** Custom forms with `card_swipe` (step-by-step) and `standard` layouts, supporting multi-page pagination and multi-column field arrangement. Integrates with public endpoints for organization and resource category selections. **Uniqueness Validation:** Application forms support enhanced uniqueness validation with configurable target fields (member.email, member.full_name, member.phone, organization.name, organization.invoicing_email, organization.phone, organization.website_url) and comparison modes (equals, equals_lowercase, contains, starts_with, ends_with, domain_equals). Backend validates target fields against whitelists and ensures domain_equals is only used with email columns. **Field Mappings:** Forms store a `field_mappings` array defining source_field_id → target_type (core/custom) → target_entity (member/organization) → target_field mappings with optional transformations (trim, uppercase, lowercase, titlecase, extract_domain, extract_username, first_word, last_word, remove_spaces, numbers_only). The ApplicationProcessor applies these transformations when creating entities from form submissions. Legacy `core_field_mapping` and `custom_field_id` on fields are supported as fallback. **Entity Creation Control:** The `create_entity_type` setting ("member", "organization", or "both") controls which entities are auto-created on submission when `auto_create_entity` is enabled.
**Speakers:** Manages speaker profiles for event assignments.
**Card Deck:** A content management feature for displaying curated card collections on dynamic pages, with admin management and styling controls.
**Configuration:** Manages navigation, menus, page banners, onboarding tours, and system settings.
**Communications:** Manages communication categories and member preferences for opt-in/opt-out.
**Custom Fields:** Supports custom preference fields for members and organizations, defining field definitions and storing values.
**Organization Fields:** Includes default contact fields (phone, invoicing_email, invoicing_address, website_url) and custom fields displayed on the `/myorganisation` page.
**Training Funds:** Organization training_fund_balance field tracks available funds. TrainingFundTransaction entity records all balance adjustments with type (add/deduct/booking_usage), amounts, before/after balances, and audit trail (created_by, created_date). Managed via TrainingFundManagement admin page.
**Vouchers:** Discrete voucher codes with organization_id, code, value, expires_at, status (active/used/expired). Managed via VoucherManagement admin page.
**Workflows:** Automation rules triggered by field changes on organizations or members. Each workflow defines: entity_type (organization/member), trigger_type (field_change/record_create/record_update), trigger_config (field, operator, value), conditions (optional AND/OR field comparisons), and actions (send_email, update_field). WorkflowLog tracks execution history with status (success/partial/failed). Managed via /WorkflowManagement admin page with a 4-step builder UI (Basics → Trigger → Conditions → Actions).

## Deployment Architecture

**Development:** Express.js with Vite middleware.
**Production:** Vercel serverless functions for API endpoints and static frontend assets.
**CRM Sync Architecture:** One-way data flow from Zoho CRM to the application, triggered on member login or manually by administrators.
**Data Freshness & Caching:** Utilizes TanStack Query for data caching and Supabase Realtime Subscriptions for live updates on specific tables.

## Runtime Page Provisioning (CMS Feature)

Enables administrators to create and manage pages/routes at runtime using a `/:slug` catch-all route for dynamic IEdit pages. Supports draft/published statuses and public/member access control.

## My Organisation Page

A dedicated page (`/myorganisation`) displaying organization details, including default contact information and custom fields, with access controlled via Role Management.

## Organisations CRM List (/organisations)

A CRM-style admin page for managing organisations with:
- **Left sidebar filters:** Search, status dropdown, and custom field filters (for filterable dropdown/picklist fields)
- **View toggle:** Switch between list (table) and card grid layouts
- **Pagination:** Navigate through large organisation lists
- **Detail view:** Click any organisation to open a CRM-style profile with:
  - Overview tab: Core details, contact info, custom fields (editable by admins)
  - Members tab: List of organisation members
  - Activity tab: Recent booking activity
  - Training fund balance display
- **Access control:** Admin-only, respects `page_OrganisationsList` and `page_OrganisationDirectory` feature exclusions

# External Dependencies

**Supabase:** Primary database for application data (PostgreSQL), used for CRUD operations and realtime subscriptions.
**Zoho CRM:** Used for contact and account synchronization, leveraging OAuth and webhooks.
**Zoho Backstage:** Integrates for event management and ticket sales with bi-directional sync.
**Stripe:** Handles all payment processing via server-side API.
**Xero:** Used for invoice generation with OAuth authentication.
**File Storage:** Handled by Supabase Storage or a Base44 integration layer.
**Email Delivery:** Used for magic links and notifications via an integration layer.

# Pending Database Migrations

The following SQL must be run in Supabase SQL Editor to enable new features:

## TrainingFundTransaction Table (for Training Fund adjustment history)

```sql
CREATE TABLE IF NOT EXISTS training_fund_transaction (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT,
  type TEXT CHECK (type IN ('add', 'deduct', 'booking_usage')),
  amount NUMERIC,
  balance_before NUMERIC,
  balance_after NUMERIC,
  reason TEXT,
  booking_id TEXT,
  created_by TEXT,
  created_date TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tft_organization_id ON training_fund_transaction(organization_id);
CREATE INDEX IF NOT EXISTS idx_tft_created_date ON training_fund_transaction(created_date DESC);
```

## Form Table - Application Form Columns

```sql
ALTER TABLE form ADD COLUMN IF NOT EXISTS auto_create_entity BOOLEAN DEFAULT FALSE;
ALTER TABLE form ADD COLUMN IF NOT EXISTS create_entity_type TEXT DEFAULT 'member';
ALTER TABLE form ADD COLUMN IF NOT EXISTS field_mappings JSONB DEFAULT '[]'::jsonb;
```

## Workflow Automation Tables

```sql
CREATE TABLE IF NOT EXISTS workflow (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('organization', 'member')),
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('field_change', 'record_create', 'record_update')),
  trigger_config JSONB,
  conditions JSONB DEFAULT '[]'::jsonb,
  actions JSONB DEFAULT '[]'::jsonb,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  created_by TEXT
);

CREATE TABLE IF NOT EXISTS workflow_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id UUID NOT NULL REFERENCES workflow(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  trigger_data JSONB,
  actions_executed JSONB,
  status TEXT NOT NULL CHECK (status IN ('success', 'partial', 'failed')),
  error_message TEXT,
  executed_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workflow_entity_type ON workflow(entity_type);
CREATE INDEX IF NOT EXISTS idx_workflow_is_active ON workflow(is_active);
CREATE INDEX IF NOT EXISTS idx_workflow_log_workflow_id ON workflow_log(workflow_id);
CREATE INDEX IF NOT EXISTS idx_workflow_log_executed_at ON workflow_log(executed_at DESC);
```