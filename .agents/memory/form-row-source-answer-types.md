---
name: Row-source answer semantics
description: Preserve the difference between selected Custom Object records and projected scalar values.
---

Classify row-source answers by their configured source semantics, not by the legacy dropdown field type. A distinct field-value choice is a scalar, never a record reference, even when its text resembles a UUID.

**Why:** Relabelling record options cannot produce a distinct manufacturer selection: several records may share that value. Treating the projection as a record ID leaks it into label lookups and structured record actions.

**How to apply:** Keep projected values literal in review/export formatting and exclude them from record-label discovery and action endpoint pickers. Record sources retain their IDs and resolve their primary display labels. Database field IDs are UUIDs, but earlier form-column IDs may be legacy strings.