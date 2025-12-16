# Overview

This project is a comprehensive membership management platform built with React (Vite) and Express.js. It facilitates the management of members, organizations, events, bookings, program tickets, resources, and blog posts, alongside essential administrative functions. The platform aims for 100% visual and functional parity with its predecessor (Base44) while leveraging modern technologies. Its core purpose is to streamline membership operations, event management, and content delivery for organizations, integrating with various external services for CRM, payments, and accounting to provide a robust, all-in-one solution.

# User Preferences

Preferred communication style: Simple, everyday language.

# System Architecture

## Frontend Architecture

The frontend utilizes React 18 with TypeScript/JSX, Vite for tooling, TanStack Query for data management, shadcn/ui (Radix UI) for UI components, and Tailwind CSS for styling. It implements client-side routing, falling back to `index.html` for SPA behavior. The design system is a customized "new-york" style from shadcn/ui, focused on achieving pixel-perfect visual and functional parity.

## Backend Architecture

The backend is built with Express.js, featuring separate development and production entry points. It uses PostgreSQL (Neon serverless) with Drizzle ORM. The API design follows a generic entity CRUD pattern, mirroring the Base44 SDK. Authentication is password-based with server-side session management (`express-session`), including login, logout, password management, and user session retrieval. An admin security model implements role-based access control using `verifyPermission()` and `useServerAdminAuth` on the frontend. Server-side functions handle specific operations such as magic link generation, Stripe payments, bookings, and event synchronization.

## Data Model

The data model encompasses core entities like Member, Organization, Role, and TeamMember. It supports role segmentation based on organization custom fields, allowing dynamic role assignment. Events and bookings are managed through Event, Booking, Program, and ProgramTicketTransaction entities, supporting both Zoho Backstage synced and one-off events, guest checkout, and various pricing models. Content management includes BlogPost, Resource, NewsPost, and a dynamic page builder with a predefined typography system. A custom forms system supports `card_swipe` and `standard` layouts, multi-page pagination, multi-column field arrangements, and advanced uniqueness validation with configurable field mappings and entity creation control. Workflows provide automation rules triggered by field changes or record creation/updates, with configurable conditions and actions (e.g., send email, update field), and support for `every_time` or `once_per_record` trigger modes. Additional features include Speaker profiles, a Card Deck content feature, comprehensive configuration for navigation and settings, communication preferences management, custom fields for members and organizations, training funds management with detailed transaction logging, and discrete voucher codes.

## Deployment Architecture

Development uses Express.js with Vite middleware. Production deployment leverages Vercel serverless functions for API endpoints and static frontend assets. Data synchronization from Zoho CRM to the application is one-way, triggered by member login or administrator actions. Data freshness is maintained using TanStack Query for caching and Supabase Realtime Subscriptions for live updates.

## Runtime Page Provisioning (CMS Feature)

The platform includes a CMS feature enabling administrators to create and manage dynamic pages and routes at runtime using a `/:slug` catch-all route, with support for draft/published statuses and public/member access controls.

## My Organisation Page

A dedicated page `/myorganisation` displays organization details, contact information, and custom fields, with access controlled via Role Management.

## Organisations CRM List (/organisations)

An admin-only CRM-style page for managing organizations, featuring search, status/custom field filters, list/card grid views, pagination, and a detailed profile view for each organization (overview, members, activity, training fund balance). Access is controlled by `page_OrganisationsList` and `page_OrganisationDirectory` feature exclusions.

## Role Management System (December 2025 Update)

The role management system uses a hierarchical Module→Page→Feature structure for controlling visibility:

**Key Files:**
- `client/src/lib/roleAccessMap.ts` - Defines 11 modules (Events, Commerce, Membership, Content, Jobs, Site Builder, Forms, Support, Communication, Admin Toolkit, System Settings) with dot-notation IDs (e.g., "events.browse-events", "commerce.buy-tickets")
- `client/src/lib/roleVisibility.ts` - Helper functions for hierarchical exclusion checking
- `client/src/pages/RoleManagement.jsx` - Admin UI with collapsible module/page/feature tree

**How it works:**
1. Roles store `excluded_features` array with hierarchical IDs
2. Blocking a module (e.g., "events") hides all its pages and features
3. Blocking a page (e.g., "events.bookings") hides that page and its features
4. Blocking a feature (e.g., "events.bookings.add-colleagues") hides just that feature
5. Legacy IDs (e.g., "page_Events") are automatically mapped to new IDs via LEGACY_TO_NEW_MAPPING

**Toggle behavior:**
- Enabling a page within an excluded module: module exclusion removed, all OTHER pages individually excluded
- Enabling a feature within an excluded page: page exclusion removed, all OTHER features individually excluded

**Dynamic Role Access Configuration (December 2025):**
- `client/src/pages/RoleAccessConfigManagement.jsx` - Admin UI for dynamically configuring the module/page/feature hierarchy
- Stores configuration in `role_access_item` Supabase table with schema: id, item_type (module|page|feature), item_key, label, icon, parent_id, display_order, is_active
- RoleManagement loads config from database with fallback to hardcoded ROLE_ACCESS_MAP if no rows exist
- Supports seed-from-defaults and reset functionality for bootstrapping configurations
- Navigation accessible under Admin > Role Management > Access Configuration

# External Dependencies

**Supabase:** Primary database (PostgreSQL) for application data, including CRUD and realtime subscriptions.
**Zoho CRM:** Used for contact and account synchronization.
**Zoho Backstage:** Integrates for event management and ticket sales.
**Stripe:** Handles all payment processing.
**Xero:** Used for invoice generation.
**File Storage:** Handled by Supabase Storage or a Base44 integration layer.
**Email Delivery:** Used for magic links and notifications via an integration layer.