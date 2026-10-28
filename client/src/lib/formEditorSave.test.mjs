import test from 'node:test';
import assert from 'node:assert/strict';
import { hydrateForm } from '../../../tests/helpers/formBuilderHydration.mjs';
import { captureFormEditorBaseline, normalizeFormEditorSave, prepareFormEditorUpdate, formEditorPatch } from './formEditorSave.js';
import { FORM_MUTATION_CONFIG_KEYS, validateFormMutationAccessSave } from '../../../shared/formMutationContract.js';

export const legacyForm = {
  id: 'legacy-fixture', name: 'Legacy application', slug: 'application-v3', is_active: true,
  require_authentication: false, mutation_access_policy: null, application_level: 'member',
  entity_action: 'create', member_entity_action: 'none', organization_entity_action: 'none',
  fields: [{ id: 'email', type: 'email', label: 'Email', options: ['', 'Yes'] }],
  entity_pipelines: { members: [{ id: 'primary', mappings: [{ target_field: 'email', source_field_id: 'email' }] }], organisations: [] },
  structured_actions: { version: 1, actions: [{ id: 'upsert', operation: 'upsert', target: { kind: 'organization_group' } }] },
};
const save = (form, previousForm) => validateFormMutationAccessSave({ form, previousForm, isCreate: !previousForm });

test('actual hydrate/save preserves exact legacy mutation keys on slug change and reload', () => {
  const editor = hydrateForm(legacyForm);
  assert.equal(save(normalizeFormEditorSave(editor), legacyForm).ok, false);
  const baseline = captureFormEditorBaseline(legacyForm, editor);
  const payload = prepareFormEditorUpdate({ ...editor, slug: 'application' }, baseline);
  for (const key of FORM_MUTATION_CONFIG_KEYS) {
    assert.deepEqual(payload[key], legacyForm[key], key);
    assert.equal(Object.hasOwn(payload, key), Object.hasOwn(legacyForm, key), key);
  }
  assert.equal(save(payload, legacyForm).legacyCompatibility, true);
  const patch = formEditorPatch(payload, baseline);
  for (const key of FORM_MUTATION_CONFIG_KEYS) assert.equal(Object.hasOwn(patch, key), false, key);
  assert.equal(save({ ...legacyForm, ...patch }, legacyForm).legacyCompatibility, true);
  const persisted = { ...legacyForm, ...payload };
  assert.equal(hydrateForm(persisted).slug, 'application');
});

test('sparse metadata patch preserves newer server access and validates it authoritatively', () => {
  const editor = hydrateForm(legacyForm);
  const baseline = captureFormEditorBaseline(legacyForm, editor);
  const patch = formEditorPatch(prepareFormEditorUpdate({ ...editor, slug: 'updated' }, baseline), baseline);
  const newer = { ...legacyForm, require_authentication: true,
    mutation_access_policy: { version: 1, mode: 'authenticated_owner' } };
  const merged = { ...newer, ...patch };
  assert.equal(merged.require_authentication, true);
  assert.deepEqual(merged.mutation_access_policy, newer.mutation_access_policy);
  assert.equal(save(merged, newer).ok, true);
  const invalid = { ...newer, require_authentication: false };
  assert.equal(save({ ...invalid, ...patch }, invalid).ok, false);
});

test('generated pipeline IDs, array actions, nulls and option cleanup use a stable snapshot', () => {
  const persisted = { ...legacyForm, entity_pipelines: null, auto_create_entity: true,
    member_entity_action: 'update', create_entity_type: 'member',
    field_mappings: [{ source_field_id: 'email', target_entity: 'member', target_field: 'email' }],
    structured_actions: legacyForm.structured_actions.actions };
  const editor = hydrateForm(persisted);
  const baseline = captureFormEditorBaseline(persisted, editor);
  assert.ok(editor.entity_pipelines.members[0].id);
  const payload = prepareFormEditorUpdate({ ...editor, slug: 'changed' }, baseline);
  assert.deepEqual(payload.structured_actions, persisted.structured_actions);
  assert.equal(payload.entity_pipelines, null);
  assert.deepEqual(payload.fields, persisted.fields);
  assert.equal(save(payload, persisted).ok, true);
});

test('genuine actions, mappings, auth changes and reactivation remain validated', () => {
  const editor = hydrateForm(legacyForm);
  const baseline = captureFormEditorBaseline(legacyForm, editor);
  for (const changes of [
    { fields: [...editor.fields, { id: 'new', type: 'text' }] },
    { entity_pipelines: { ...editor.entity_pipelines, members: [] } },
    { structured_actions: { version: 1, actions: [...editor.structured_actions.actions,
      { operation: 'upsert', target: { kind: 'organization' } }] } },
    { mutation_access_policy: { version: 1, mode: 'applicant_continuation' } },
  ]) {
    const payload = prepareFormEditorUpdate({ ...editor, ...changes }, baseline);
    assert.notEqual(save(payload, legacyForm).legacyCompatibility, true);
  }
  const authenticated = prepareFormEditorUpdate({ ...editor, require_authentication: true }, baseline);
  assert.equal(save(authenticated, legacyForm).policy.mode, 'authenticated_owner');
  assert.equal(save(normalizeFormEditorSave(editor), null).ok, false);
  const draft = { ...legacyForm, is_active: false };
  const draftEditor = hydrateForm(draft);
  assert.equal(save(prepareFormEditorUpdate({ ...draftEditor, is_active: true },
    captureFormEditorBaseline(draft, draftEditor)), draft).ok, false);
});

test('invalid explicit policies are not bypassed by metadata saves', () => {
  for (const policy of [{ version: 1, mode: 'applicant_continuation' },
    { version: 1, mode: 'authenticated_owner' }, { version: 99, mode: 'unknown' }]) {
    const persisted = { ...legacyForm, mutation_access_policy: policy };
    const editor = hydrateForm(persisted);
    const payload = prepareFormEditorUpdate({ ...editor, slug: 'changed' }, captureFormEditorBaseline(persisted, editor));
    assert.deepEqual(payload.mutation_access_policy, policy);
    assert.equal(save(payload, persisted).ok, false);
  }
});

test('save acknowledgement baseline retains edits made while saving', () => {
  const editor = hydrateForm(legacyForm);
  const payload = prepareFormEditorUpdate({ ...editor, slug: 'first' }, captureFormEditorBaseline(legacyForm, editor));
  const acknowledged = captureFormEditorBaseline({ ...legacyForm, ...payload }, { ...editor, slug: 'first' });
  const pending = { ...editor, slug: 'second', require_authentication: true };
  assert.equal(prepareFormEditorUpdate(pending, acknowledged).require_authentication, true);
  assert.equal(prepareFormEditorUpdate(pending, acknowledged).slug, 'second');
});
