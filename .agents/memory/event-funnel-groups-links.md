---
name: Event funnel groups and event links
description: Naming and scoping rules for Funnel Groups and per-event funnel links.
---
- Funnel Groups are stored as "collections" (event_funnel_collection*), because the event_funnel_group_* names already belong to group-booking features.
- An event's link to a funnel or group narrows routing inside the SQL entry resolver, so every caller (entry, start, switch source, standalone check) applies the same scope. With no link, routing is unchanged.
- Deleting a group explicitly clears the event links that point to it. A funnel that an event links to directly cannot be deleted.

**Why:** User asked that events open straight onto their own funnels instead of searching every funnel. Applying the scope only in the client would let different routing paths disagree.
**How to apply:** Any new routing RPC must call event_funnel_in_event_scope. Never filter only in JS.
