---
name: record_create workflows vs custom-field conditions
description: Ordering requirement for triggering record_create workflows when conditions read preference values, and workflow_log status constraint.
---

# record_create workflows & custom-field conditions

The workflow engine evaluates `member_custom`/`org_custom` conditions by reading
`member_preference_value`/`organization_preference_value` AT TRIGGER TIME. Any
path that creates an entity and then saves its custom-field values must fire
`triggerWorkflows(..., 'record_create', ...)` AFTER the preference values are
persisted, or custom-field conditions silently see empty values.

**Why:** the form application processor originally triggered right after the
member insert, so workflows conditioned on a custom field captured in the same
submission never matched — silently, with no workflow_log evidence.

**How to apply:** in creation flows, stash the created row and trigger after the
preference upsert/clear loop. The generic entity-API POST path CANNOT be fixed
this way — the admin UI saves custom fields in separate follow-up
MemberPreferenceValue POSTs, so record_create workflows there evaluate empty
custom fields by design (documented in the entity POST handler).

Also: `workflow_log.status` has a DB check constraint; allowed values are
`success | partial | failed | skipped` ('skipped' = conditions-not-met runs,
with `trigger_data.condition_results` holding expected vs actual).
`checkOncePerRecord` must ignore 'skipped' rows, or a once_per_record workflow
whose conditions were false on first trigger can never execute later.
