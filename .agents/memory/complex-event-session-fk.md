---
name: complex_event_session FK column
description: Which column links complex_event_session to its parent complex_event.
---
The parent FK on `complex_event_session` is **`complex_event_id`**, not `event_id` (the table has no `event_id` column).

**Why:** Some existing code (e.g. parts of `api/my-tickets/index.js`) queries `.in('event_id', ...)` on this table, which is misleading to copy — PostgREST would error/return nothing. Verified column list against the prod DB.

**How to apply:** When joining sessions to complex events (earliest session date, session listings), always select/filter/key by `complex_event_id`. Session start column is `start_time`.
