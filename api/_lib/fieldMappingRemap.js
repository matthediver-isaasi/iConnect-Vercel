// Shared helpers for resolving and remapping stage_field_mapping_action
// `source_field_id` values against a form's field list.
//
// Background: a field-mapping action stores `source_field_id` — the DD form
// field id (typically `field.id`, falling back to `field.name`). When DD config
// is copied from one form to another (Seed from another form) or a form is
// duplicated and then independently edited, those source ids stay pointing at
// the ORIGINAL form's fields. On the target/duplicate form the ids no longer
// exist, so the mapping resolves to nothing at execution and renders a blank
// dropdown in the config editor.
//
// These helpers let us (a) detect a dangling source reference against a given
// form and (b) translate a source id from one form to another by matching on
// field label (falling back to name, then key).

function normalizeMatchKey(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim().toLowerCase();
}

// A mapping only carries a meaningful source_field_id when it is a form-field
// source. Static / current-date / clear sources don't reference a form field.
export function isFieldSourceMapping(mapping) {
  if (!mapping) return false;
  const st = mapping.source_type;
  if (st === 'static' || st === 'current_date' || st === 'clear') return false;
  if (mapping.transformation === 'current_date') return false;
  return true;
}

// Find the field on a form that a source id refers to (by id, name, or key).
export function findFieldBySourceId(sourceId, formFields = []) {
  if (sourceId === null || sourceId === undefined || sourceId === '') return null;
  const sid = String(sourceId);
  return (
    (formFields || []).find(
      (f) =>
        f &&
        (String(f.id) === sid ||
          (f.name !== undefined && f.name !== null && String(f.name) === sid) ||
          (f.key !== undefined && f.key !== null && String(f.key) === sid))
    ) || null
  );
}

// Whether a source id resolves to a real field on the given form.
export function sourceFieldExistsOnForm(sourceId, formFields = []) {
  return !!findFieldBySourceId(sourceId, formFields);
}

// The stored source id for a field mirrors how the config editor writes it:
// `field.id || field.name`.
function sourceIdForField(field) {
  if (!field) return null;
  if (field.id !== undefined && field.id !== null && field.id !== '') return String(field.id);
  if (field.name !== undefined && field.name !== null && field.name !== '') return String(field.name);
  return null;
}

// Translate a single source id from the source form to the target form by
// matching on label, then name, then key. Only non-empty attributes are
// considered so two fields that both lack a name/label don't collapse together.
// Returns { ok, targetFieldId, matchedBy, ambiguous, reason }.
export function remapSourceFieldId(sourceId, sourceFormFields = [], targetFormFields = []) {
  const sourceField = findFieldBySourceId(sourceId, sourceFormFields);
  if (!sourceField) {
    return {
      ok: false,
      targetFieldId: null,
      matchedBy: null,
      ambiguous: false,
      reason: 'source_field_not_found_on_source_form',
    };
  }

  const attempts = [
    { by: 'label', value: sourceField.label },
    { by: 'name', value: sourceField.name },
    { by: 'key', value: sourceField.key },
  ];

  for (const attempt of attempts) {
    const needle = normalizeMatchKey(attempt.value);
    if (!needle) continue;
    const matches = (targetFormFields || []).filter(
      (f) => f && normalizeMatchKey(f[attempt.by]) === needle
    );
    if (matches.length === 0) continue;
    const targetFieldId = sourceIdForField(matches[0]);
    if (!targetFieldId) continue;
    return {
      ok: true,
      targetFieldId,
      matchedBy: attempt.by,
      ambiguous: matches.length > 1,
      reason: null,
    };
  }

  return {
    ok: false,
    targetFieldId: null,
    matchedBy: null,
    ambiguous: false,
    reason: 'no_equivalent_field_on_target_form',
  };
}

// Remap every field-source mapping in an array from the source form to the
// target form. Non-field sources (static / current_date / clear) and sources
// that already resolve on the target form are passed through unchanged.
// Returns { mappings, remapped, unchanged, dropped } where `dropped` lists the
// mappings whose source could not be translated (caller decides whether to drop
// or flag them).
export function remapFieldMappings(mappings = [], sourceFormFields = [], targetFormFields = [], { dropUnmatched = true } = {}) {
  const out = [];
  const dropped = [];
  let remapped = 0;
  let unchanged = 0;

  for (const mapping of mappings || []) {
    if (!isFieldSourceMapping(mapping)) {
      out.push(mapping);
      unchanged += 1;
      continue;
    }

    const sourceId = mapping.source_field_id;

    // Already valid on the target form — keep as-is.
    if (sourceFieldExistsOnForm(sourceId, targetFormFields)) {
      out.push(mapping);
      unchanged += 1;
      continue;
    }

    const result = remapSourceFieldId(sourceId, sourceFormFields, targetFormFields);
    if (result.ok) {
      out.push({ ...mapping, source_field_id: result.targetFieldId });
      remapped += 1;
    } else {
      dropped.push({ mapping, reason: result.reason });
      if (!dropUnmatched) out.push(mapping);
    }
  }

  return { mappings: out, remapped, unchanged, dropped };
}
