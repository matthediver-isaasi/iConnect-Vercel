import { FORM_MUTATION_CONFIG_KEYS } from '../../../shared/formMutationContract.js';

const keys = [...FORM_MUTATION_CONFIG_KEYS, 'access_policy', 'is_active'];
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
    : value;
const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

// Use exactly the same cleanup for the initial editor snapshot and each save.
export function normalizeFormEditorSave(form) {
  const { _ccCustomMode, _bccCustomMode, survey_audit_log, ...data } = form;
  data.structured_actions = {
    version: 1,
    actions: Array.isArray(form.structured_actions) ? form.structured_actions
      : form.structured_actions?.actions || [],
  };
  data.fields = (form.fields || []).map(field => (
    !Array.isArray(field.options) || field.type === 'image_options' ? field
      : { ...field, options: field.options.filter(option => typeof option !== 'string' || option.trim() !== '') }
  ));
  return data;
}

export function captureFormEditorBaseline(persisted, editor) {
  return { persisted: clone(persisted), editor: clone(normalizeFormEditorSave(editor)) };
}

export function prepareFormEditorUpdate(editor, baseline) {
  const data = normalizeFormEditorSave(editor);
  if (!baseline) return data;
  for (const key of keys) {
    if (!equal(data[key], baseline.editor[key])) continue;
    if (Object.hasOwn(baseline.persisted, key)) data[key] = clone(baseline.persisted[key]);
    else delete data[key];
  }
  return data;
}

// PATCH must leave unchanged keys absent: this also avoids server-side action
// normalizers and prevents stale tabs from overwriting newer access settings.
export function formEditorPatch(prepared, baseline) {
  if (!baseline) return prepared;
  const patch = { ...prepared };
  for (const key of keys) {
    if (equal(prepared[key], baseline.persisted[key])) delete patch[key];
  }
  return patch;
}
