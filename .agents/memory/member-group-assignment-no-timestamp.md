---
name: member_group_assignment join timestamp
description: The join-date column on member_group_assignment and why old rows are still inaccurate
---

`member_group_assignment` now has a `created_at timestamptz NOT NULL DEFAULT now()`
column (added via migration `20260702_member_group_assignment_created_at.sql`).
New joins capture their real moment automatically through the DEFAULT.

**Why it matters:** rows that existed BEFORE that column was added were backfilled
to the migration run time by the DEFAULT — their true historical join dates are
unrecoverable. So `member_group_activity` "joined" events for pre-column
memberships are still only as accurate as `now()` at backfill time; only joins
that happened after the column existed carry a real date.

**How to apply:** `scripts/backfill-member-group-activity.mjs` selects and uses
`created_at` from `member_group_assignment` (falls back to `now()` if absent).
New joins are recorded live by the recorder (`api/_lib/memberGroupActivity.js`).
Do not expect real join dates for legacy rows.
