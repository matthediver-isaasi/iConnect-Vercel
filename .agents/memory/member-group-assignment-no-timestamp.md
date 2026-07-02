---
name: member_group_assignment has no join timestamp
description: Why member group "joined" activity backfills cannot use a real historical date
---

`member_group_assignment` has NO created/joined timestamp column (no `created_at`,
`joined_at`, or equivalent). Only term dates (`term_start_date`/`term_end_date`),
`expires_at`, and the term snapshot fields carry dates.

**Why it matters:** any backfill of `member_group_activity` "joined" events for
pre-existing memberships must fall back to `now()` for the event date — the true
historical join date does not exist in the DB and is unrecoverable. New joins are
recorded accurately at the moment they happen by the recorder
(`api/_lib/memberGroupActivity.js`); only historical/backfilled rows are affected.

**How to apply:** if you touch `scripts/backfill-member-group-activity.mjs` do NOT
select a `created_at` from `member_group_assignment` (it will error). To get real
historical dates, first add a `created_at`/`joined_at` column to the table.
