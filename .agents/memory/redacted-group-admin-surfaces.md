---
name: Redacted group-admin data surfaces
description: How to expose tenant-wide signal to group admins without leaking other groups' private details.
---

Group admins (members carrying per-assignment `is_group_admin` on an
events-enabled group) sometimes need a tenant-wide *signal* (e.g. "your event
time clashes with N other events") without seeing any private details of events
they don't own — including other groups' private events.

**Rule:** when an admin-only endpoint adds a group-admin caller path, branch the
RESPONSE, not just the auth gate. Run the same detection, but for the redacted
caller strip every identifying field and return only a boolean + a count
(e.g. `{ hasClashes, redacted: true, clashCount, clashes: [] }`). Tenant admins
keep the full detailed payload.

**Why:** the clash list intentionally spans tenant-admin + all-group events
(incl. group-private rows). Reusing the same query for group admins would leak
titles/times/group names unless the response is redacted on EVERY success branch
(empty-input early return AND the normal path).

**How to apply:** authorize group admins via `getCallerGroupEventsAccess(req)`
(`groups.length > 0`); keep the existing 403 for plain members and 401 for
unauth. Client helper + dialog must thread a `redacted` flag so the UI shows a
count-only summary and hides the per-item list. Saving must never be blocked.
Reference: `api/events/check-clashes.js`, `client/src/lib/eventClash.js`,
`client/src/components/events/EventClashWarningDialog.jsx`.
