# Routes Audit: server/routes.ts vs api/ folder

## Summary

The codebase has **two backend implementations** that must stay in sync:
1. `server/routes.ts` - Express.js for local Vite development (127 endpoints)
2. `api/` folder - Vercel serverless functions for production (87 files)

**Key Finding**: The `api/functions/[functionName].js` is a dynamic catch-all route that handles 50+ function calls, so most `/api/functions/*` endpoints ARE implemented in Vercel.

## Endpoint Comparison

### Endpoints in server/routes.ts but NOT as separate files in api/

These are handled by the `api/functions/[functionName].js` catch-all:
- `/api/functions/sendMagicLink` - Implemented in catch-all
- `/api/functions/verifyMagicLink` - Implemented in catch-all
- `/api/functions/createBooking` - Implemented in catch-all
- `/api/functions/createStripePaymentIntent` - Implemented in catch-all
- (50+ more functions - all handled by catch-all)

### Endpoints ONLY in server/routes.ts (not in Vercel):

1. `/api/admin/backfill-job-posting-dates` - Admin utility
2. `/api/admin/members/:id` (GET/PATCH) - Member admin (Vercel has /admin/members/:memberId)
3. `/api/admin/roles/member-counts` - Role statistics
4. `/api/auth/test-session` - Development testing only
5. `/api/file-migration/*` - One-time migration utilities
6. `/api/migrate/portal-menu-parents` - One-time migration

### Endpoints ONLY in api/ folder (not in routes.ts):

1. `/api/admin/member-notes/:noteId` - Member notes CRUD
2. `/api/admin/members/dedupe` - Deduplication utility
3. `/api/admin/members/:memberId/notes` - Member notes list
4. `/api/admin/organizations` - Organizations list
5. `/api/admin/roles` - Roles list
6. `/api/cron/send-event-reminders` - Cron job
7. `/api/debug-workflows` - Debugging
8. `/api/event-emails/:eventId` - Event email management
9. `/api/organisation-directory` - Directory endpoint
10. `/api/xero/callback` - OAuth callback
11. `/api/zoom/webinars/:id/panelists/:panelistId` - Zoom panelist management

## Recommendation

Since the team deploys exclusively to Vercel:

1. **Deprecate server/routes.ts** - It only serves local development which isn't used
2. **Keep api/ folder as source of truth** - All production traffic uses these
3. **Move any unique routes.ts logic to api/** - The few endpoints only in routes.ts
4. **For multi-tenancy work** - Only modify the api/ folder

## Files to Keep

- `api/` folder - Production backend
- `api/_lib/` - Shared utilities (session, email, workflows, etc.)

## Files to Archive/Remove

- `server/routes.ts` - 17,000+ lines of duplicate code
- `server/index.ts` - Express entry point
- `server/vite.ts` - Vite dev middleware
- Related Express middleware

## Action Items

1. Ensure all routes.ts-only endpoints are migrated to api/ if needed
2. Archive server/ folder contents
3. Update npm scripts and workflow configuration
4. Proceed with multi-tenancy work in api/ folder only
