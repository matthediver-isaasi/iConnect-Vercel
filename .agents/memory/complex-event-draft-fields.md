---
name: complex_event has two independent "draft" fields
description: status vs event_state on complex_event — both can mean "draft" and must both be checked.
---

`complex_event` rows carry TWO separate fields that each express a kind of draft:

- `status`: publication status — `published` | `tbc` | `draft` (also other values).
- `event_state`: lifecycle state — `active` | `draft` | `closed` (set in CreateComplexEvent.jsx).

An event can be `status='published'` AND `event_state='draft'` at the same time. Treat an event as "draft" if EITHER field is `draft`.

**Why:** the public list endpoint `api/public/complex-events.js` filters `event_state` to null/active/closed (hides draft-state events) AND `status` to published/tbc. So a published-but-draft-state event is invisible to the public list and has no `session_count` there. Any admin-side feature that wants draft events (e.g. the Canvas Builder "Event sessions" picker) must read via the authenticated entity API (`base44.entities.ComplexEvent` / `ComplexEventSession.listAll()`), not the public list.

**How to apply:** the single-event read `api/public/complex-event.js` and `api/complex-event-sessions/public.js` gate on `status` in (published, tbc, draft) and do NOT filter `event_state`, so rendering works for published/draft-state events. When filtering or labelling drafts, check both `status` and `event_state`.
