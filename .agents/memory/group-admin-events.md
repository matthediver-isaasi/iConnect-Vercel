---
name: Group-Admin scoped event editing
description: How Group Admins reuse the real event editors under guardrails, and why server+client guardrails must stay in lockstep.
---

# Group-Admin scoped event editing

Group Admins (the `n` boolean on `MemberGroupAssignment` — NOT a dedicated `is_group_admin` column, NOT the dropped `events_enabled_roles`) of `events_enabled` groups can create/edit the REAL simple `Event` and `ComplexEvent` (no bespoke RSVP system anymore).

## Two enforcement layers that MUST match
- **Server (authoritative):** `api/_lib/groupAdminEventWrite.js` — `authorizeGroupAdminEventWrite` is wired into the generic entity API POST (`api/entities/[entity]/index.js`) and PATCH (`api/entities/[entity]/[id].js`); `authorizeGroupAdminEventDelete` guards both `delete-with-cancellations` endpoints. Tenant admins (`hasAdminAccess`) pass straight through unchanged.
- **Client (UX only):** the editors enter "limited mode" via URL param `group_event=1` (+ `group_id`), or defensively when a loaded event has `member_group_id` and the user is not a tenant admin.

**Why:** the generic entity API historically had NO server-side admin gate on tenant-scoped event writes — RBAC was client-side only. The group-admin layer is the first server gate, so it both authorizes group admins AND tightens overall security. Any new guardrail added to one layer must be mirrored in the other or the client will offer something the server rejects (or vice versa).

## The three guardrails (kept in sync across server + CreateEvent.jsx + EditEvent.jsx + CreateComplexEvent.jsx)
1. Free tickets only (force `is_free`/`price=0`; strip early-bird/group-ticket/offer/VAT). Simple tickets live in `pricing_config.ticket_classes`; complex via `ComplexEventTicketClass`.
2. No Zoom — manual online only: pasted link in `online_meeting_url` + manual start/end times. Complex sessions: manual location/link, zoom fields nulled.
3. `member_group_id` locked to an administered group; per-event audience via `group_event_public` (false=group-only default, true=public). Both `event` and `complex_event` carry `group_event_public`.

## Visibility (/Events)
Public APIs filter `member_group_id.is.null OR group_event_public.is.true` so anon never sees group-only events. Authenticated non-members are filtered client-side in `useEventsData.js`; group-only events show a "Members only" badge. Dormant old RSVP-style group events (member_group_id set, no ticket classes) are hidden.

**How to apply:** when changing what a group event may contain, edit `groupAdminEventWrite.js` AND all three editor files together; check the booking flow self-only guards too (group events are self-registration only, enforced in `api/public/complex-event-booking.js` and the simple booking path).
