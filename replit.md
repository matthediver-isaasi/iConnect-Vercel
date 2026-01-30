# Overview

This project is a multi-tenant SaaS membership management platform designed to provide organizations with a comprehensive solution for managing members, events, bookings, resources, and blog posts. It aims to consolidate various organizational management functions into a single, efficient platform, offering significant market potential. Key capabilities include a unified identity system, a dynamic page builder, custom forms, workflow automation, and a robust Due Diligence process. The platform supports a three-tier hierarchy (TENANT, ORGANIZATION, MEMBER) with strong access control and data isolation.

# User Preferences

Preferred communication style: Simple, everyday language.

# System Architecture

## Core Technologies
The frontend is built with React 18 (TypeScript/JSX), Vite, TanStack Query, shadcn/ui (Radix UI), and Tailwind CSS. The backend uses Express.js, PostgreSQL (Neon serverless), and Drizzle ORM. All API endpoints are deployed as Vercel serverless functions.

## Multi-Tenant Architecture
The platform is designed for multi-tenancy, ensuring data isolation across GLOBAL, TENANT, ORGANIZATION, and MEMBER levels, primarily using `tenant_id` and `organization_id` for scoping.

## Identity and Access Management
A unified identity system (`tenant_identity` table) manages user authentication, supporting multiple tenant ownership and organization memberships, with per-tenant password isolation and Google OAuth. A feature-based role management system provides granular control over UI visibility and backend access, including protected system roles and role-based field access control.

## Deployment & Domain Structure
The application is deployed on Vercel, utilizing `iconn.app` for tenant owner management and `{tenant}.iconn.app` for member portals, enabled by cross-subdomain session cookies.

## Key Features and Modules
-   **Core Data Model:** Includes Member, Organization, Role, and TeamMember entities.
-   **Content Management:** Event/booking management, general content management, dynamic page builder, custom forms with conditional logic, and blog posts.
-   **Communication:** Email template placeholder system for dynamic emails, and communication preferences management.
-   **Workflow Automation:** Tenant-scoped workflows for automating actions based on entity events (e.g., organization, member, job posting), including a Due Diligence process flow for reviewing form submissions, scoring, and contract signing.
-   **Branding & Customization:** Per-tenant branding system for public-facing pages, allowing customization of colors, logos, and page configurations.
-   **Form Embedding:** Forms can be embedded on external websites via iFrame with a public API.
-   **API Patterns:** Public API endpoints for unauthenticated access (e.g., `/api/public/system-settings`), and authenticated endpoints using `getTenantContext(req)` for session handling.
-   **Data Management:** Server-side pagination for large lists, and a robust data migration system for transferring data from legacy systems, including file migrations and URL updates.
-   **Email Domain Provisioning:** Automated Mailgun domain provisioning for each tenant.
-   **Realtime Updates:** Supabase Realtime Subscriptions for frontend cache invalidation.
-   **Booking System:** Agent booking system with tenant-scoped meeting templates.

## UI/UX
The frontend utilizes a custom "new-york" design system, leveraging shadcn/ui (Radix UI) and Tailwind CSS for a consistent and responsive user experience, including a collapsible sidebar.

# External Dependencies

-   **Supabase:** Primary database (PostgreSQL) and file storage.
-   **Stripe:** Payment processing.
-   **Xero:** Invoice generation.
-   **Microsoft Graph API:** Outlook email integration.
-   **Mailgun:** Tenant-specific email sending domains and email delivery.
-   **Zoho Campaigns:** Email marketing list synchronization.

## Zoho Campaigns Integration

Syncs member communication preferences to Zoho Campaigns mailing lists in real-time. Credentials are stored per-tenant in the database, supporting multi-tenant deployments where each tenant may use different Zoho accounts in different regions.

### Required Environment Variables

| Variable | Description |
|----------|-------------|
| `INTERNAL_API_SECRET` | Used for encrypting stored credentials and OAuth tokens (already configured) |
| `SESSION_SECRET` | Fallback for token encryption and OAuth state signing |

Note: Zoho Client ID and Client Secret are now stored per-tenant in the database (encrypted), not as global environment variables.

### Database Migration Required

Run this SQL in Supabase SQL Editor before using:

```sql
-- Add zoho_list_id column to communication_category table
ALTER TABLE communication_category 
ADD COLUMN IF NOT EXISTS zoho_list_id TEXT;

COMMENT ON COLUMN communication_category.zoho_list_id IS 'Zoho Campaigns mailing list ID for syncing subscribers';
```

### Setup Instructions

1. **Create Zoho OAuth Client:**
   - Go to [Zoho API Console](https://api-console.zoho.com/)
   - Create a "Server-based Application"
   - Add redirect URI: `https://your-domain.com/api/zoho-campaigns/oauth?action=callback`

2. **Configure and Connect in Admin Integrations:**
   - Navigate to Admin > Integrations page
   - Find the Zoho Campaigns section
   - Select your Zoho region (US, EU, IN, AU) - this determines OAuth and API domains
   - Enter your Client ID and Client Secret from Zoho API Console
   - Click "Save Credentials"
   - Click "Connect Zoho Account" to authorize
   - You'll be redirected back with connection confirmed

3. **Map Categories to Lists:**
   - For each communication category, select a Zoho mailing list from the dropdown
   - Click "Sync" to push current subscribers to that list

### How Sync Works

- **Admin Sync:** Click "Sync" on any category to push all eligible, subscribed members to the mapped Zoho list
- **Member Real-time Sync:** When a member changes their subscription preferences or opts out of all communications, their status is automatically synced to all mapped Zoho lists
- **Opt-out Handling:** Members who opt out of all communications are removed from all Zoho lists

### API Endpoints

| Endpoint | Method | Access | Description |
|----------|--------|--------|-------------|
| `/api/zoho-campaigns/oauth?action=status` | GET | Admin | Check if Zoho is connected |
| `/api/zoho-campaigns/oauth?action=auth-url` | GET | Admin | Get OAuth authorization URL |
| `/api/zoho-campaigns/lists` | GET | Admin | Fetch available Zoho mailing lists |
| `/api/zoho-campaigns/sync` | POST | Admin/Member | Sync subscribers (bulk or single member) |

### Security Notes

- OAuth state parameter is HMAC-signed to prevent tenant spoofing
- Tokens are encrypted at rest using AES-256-CBC with `INTERNAL_API_SECRET` (falls back to `SESSION_SECRET`)
- Members can only sync their own preferences; bulk sync requires admin access