---
name: Group-scoped rows must be excluded from tenant-wide list surfaces
description: When you add member_group_id to an entity that already has tenant-wide list pages, group rows leak into those lists unless every surface filters them out.
---

Adding a `member_group_id` to an existing tenant entity (so it can be scoped to a member group) does NOT automatically hide those rows from the entity's existing tenant-wide list surfaces. Every list path keeps returning ALL tenant rows, so group rows leak into the global library.

**Why:** The generic entity API and public list endpoints filter by `tenant_id`/`status`, not by group membership. A new group row with `member_group_id` set satisfies those filters and shows up everywhere the entity is listed — including publicly if `is_public`.

**How to apply:** Mirror how group events are hidden from `/Events` (`client/src/hooks/useEventsData.js` filters out `member_group_id` when not in a group context). For a newly group-scoped entity you must exclude `member_group_id` rows on EVERY tenant-wide surface:
- Public list endpoint(s): add `.is('member_group_id', null)` to the Supabase query (the public select usually doesn't even return the column, so client-side filtering there is unreliable — do it server-side).
- Authenticated/admin list pages that call `base44.entities.X.list(...)`: filter `!r.member_group_id` client-side in the queryFn.
- Don't forget the public single-item-by-id/slug endpoint too, or a non-member can still fetch a group item directly (this one is easy to miss).

Also: check the entity's `status` enum before setting a status on programmatic create. Resource's enum is only `draft|active` (not `published`); an out-of-enum value can break visibility filters that key off status.
