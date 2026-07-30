---
name: Outlook busy-time handling
description: Graph calendarview quirks for the public booking flow (naive datetimes, pagination, fail-open flagging)
---

- Graph `/me/calendarview` with `Prefer: outlook.timezone="<IANA>"` returns event times WITHOUT an offset, in that timezone. Never detect "has offset" with `includes('-')` — every ISO date has hyphens. Only a trailing `Z` or `±HH:MM` is absolute; otherwise convert with `fromZonedTime(str, tz)` (accepts naive strings directly). Shared parser: `api/_lib/busyTimes.js`.
- Graph can echo Windows tz names ("GMT Standard Time"); `fromZonedTime` yields Invalid Date — fall back to the agent's IANA tz.
- calendarview must follow `@odata.nextLink` (page cap) or events past `$top` are silently dropped.
- Calendar fetch failures are fail-open by product choice (slots still served, internal checks only) but must flag `outlook_connection.status`/`sync_error` (pattern from `api/outlook/send.js`) so it's visible via `/api/outlook/status`. Booking POST re-checks busy times at confirm time and 409s on conflict.

**Why:** applicants were booking over real Outlook meetings for any agent whose tz offset ≠ UTC (e.g. UK in BST), and silently once >100 events or a broken token.
**How to apply:** any new consumer of Graph calendar times must go through the shared parser and pagination-aware `getBusyTimes`.
