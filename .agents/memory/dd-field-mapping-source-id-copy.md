---
name: DD field-mapping source_field_id breaks on copied/duplicated forms
description: Why DD stage field mappings silently fail after seed/duplicate, and the label-based remap fix
---

# DD field-mapping `source_field_id` is form-scoped and breaks on copy

`stage_field_mapping_action.field_mappings[].source_field_id` stores a DD **form
field id** (written by the config editor as `field.id || field.name`). It is
scoped to ONE form. When DD config is copied to another form (Seed-from-another-form
in `api/due-diligence/seed-config.js`) or a form is duplicated and edited, the
source ids keep pointing at the ORIGINAL form's fields. On the target form those
ids don't exist, so:
- config editor source dropdown renders blank (value matches no option)
- at execution nothing is written to the target org field — silent no-op.

**Fix pattern:** translate `source_field_id` from source form to target form by
matching field **label** (fall back to name, then key). Shared pure helper:
`api/_lib/fieldMappingRemap.js` (`remapFieldMappings`, `isFieldSourceMapping`,
`sourceFieldExistsOnForm`, `remapSourceFieldId`). It's React-free so both the
seed endpoint and one-off scripts import it.

**Why label-only is often the ONLY reliable match:** on real tenant forms the
DD fields have `name: undefined` — only `label` is populated. Name/key fallback
is useless there, so never rely on name/key alone; and only match on non-empty
attributes or two unnamed fields collapse together.

**Detection vs drop rules:**
- A mapping is "broken" only when it IS a field source (not static/current_date/
  clear) AND `source_field_id` is non-empty AND resolves to nothing on the form.
  An empty source id is "unfilled", not "broken".
- On save, only drop genuinely-empty rows. A broken-but-non-empty source id still
  passes API validation (`source_field_id` truthy) and must be KEPT, not dropped.

**Executor is already form-scoped** (`api/due-diligence/_stageActions.js`) — the
bug is purely the dangling id, not the execution path.

Remediation script: `scripts/fix-dd-field-mapping-source-ids.mjs` (dry-run
default, `--apply`, uses DEST_* supabase-js, idempotent — re-run finds 0 broken).
