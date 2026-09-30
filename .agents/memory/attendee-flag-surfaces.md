---
name: Per-attendee boolean flag surfaces
description: The full set of code surfaces a new per-attendee booking flag (like buddy/badge) must touch to work end-to-end.
---

# Per-attendee boolean flag surfaces

A per-attendee boolean (e.g. `buddy`, `badge`) lives as a column on BOTH `booking`
and `complex_event_booking` and must be wired through every surface or it silently
half-works. To add one, mirror an existing flag end-to-end:

1. **DB**: add column to both `booking` and `complex_event_booking` via an idempotent
   `supabase/migrations/*.sql` + a `scripts/apply-*.mjs` runner. Apply from this
   workspace with a `pg` client on `DEST_DATABASE_URL` (pooler is IPv4-reachable);
   the direct host is not. Include `NOTIFY pgrst, 'reload schema'`.
2. **Admin toggle endpoint**: `api/admin/events/[eventId]/attendees/<flag>.js` —
   resolves which of the two tables the bookingId is in, updates, returns the value.
3. **Check-in resolver**: `api/_lib/checkinService.js` — add to both selects + both
   returned attendee objects (QR screen reads this).
4. **Dashboard API**: `api/admin/event-checkin/index.js` — both selects + both row
   mappings (simple `dashboard` and `complexDashboard`).
5. **Report API**: `api/reports/event-registration-report.js` — both booking selects
   + the attendee mapping (drives the report table AND the CSV export rows).
6. **Report UI**: `client/src/pages/EventRegistrationReport.jsx` — mutation +
   render cell + a `<th>` and `<td>` in BOTH table layouts (grouped py-3 and
   non-grouped py-2 rows) + a CSV header and CSV row value.
7. **QR screen**: `client/src/pages/EventCheckIn.jsx` — indicator banner + the
   condition guarding the indicators block.
8. **Dashboard UI**: `client/src/pages/EventCheckInDashboard.jsx` — a `<Badge>` +
   the condition guarding the indicators block.

**Default-true vs default-false matters everywhere.** A default-TRUE flag (badge)
must treat null/missing as on: read it as `x.badge !== false` in every API mapping
and every UI `checked=` / CSV value, NOT `!!x.badge`. A default-false flag (buddy)
uses `!!x.buddy`. The toggle endpoint stores `value === true || value === 'true'`
regardless of default.

**Why:** these flags are NOT in `shared/schema.ts` or a Prisma schema — the booking
tables are accessed via supabase-js, so there is no schema file to update and no
single source of truth that fans out. Each surface is independent; miss one and the
flag appears to work in the report but vanishes on the check-in screen (or vice versa).
