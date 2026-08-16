---
name: member_note column drift
description: Two incompatible member_note insert shapes coexist; the wrong one fails silently.
---

The admin timeline reads `member_note` by `target_member_id`/`author_member_id`, but some older code inserts with `member_id`/`created_by`. Because supabase-js returns `{error}` without throwing, the wrong-shape inserts fail silently and notes never appear.

**Why:** the merge audit note originally used the legacy shape and "succeeded" with no note written.

**How to apply:** before inserting into `member_note`, grep the live notes API for the current column contract and always check the returned `error`.
