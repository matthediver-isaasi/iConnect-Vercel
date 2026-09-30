---
name: Controlled composite pending state
description: Preventing sibling update races in controlled composite fields such as repeatable form rows.
---

When a controlled composite field emits multiple dependent sibling updates, retain the latest queued composite value until the parent acknowledges it, and use that queued value for both subsequent mutations and rendering.

**Why:** Protecting only mutation callbacks is insufficient. An intermediate render from an older parent snapshot can still unmount newly selected child controls, trigger cleanup effects, and erase both sibling updates.

**How to apply:** Reconcile incoming controlled values against the pending composite snapshot. Until they match, derive child props, validation, counts, and sibling calculations from the pending snapshot; use raw incoming values only for acknowledgement and normalization.