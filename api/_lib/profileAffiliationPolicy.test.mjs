import test from 'node:test';
import assert from 'node:assert/strict';
import { validateProfileAffiliationConfig, normalizeProfileAffiliationRequest } from './profileAffiliationPolicy.js';
import { rejectGenericAffiliationWrite } from './profileAffiliationEntityBoundary.js';
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function fixture(reverse = false) {
  const relationships = [
    { id: id(1), source_kind: 'custom_object', target_kind: 'member', source_custom_object_id: id(10), cardinality: 'many_to_many' },
    { id: id(2), source_kind: 'custom_object', target_kind: 'organization', source_custom_object_id: id(10), cardinality: 'many_to_one' },
    { id: id(3), source_kind: 'custom_object', target_kind: 'member', source_custom_object_id: id(11), cardinality: 'many_to_one' },
    { id: id(4), source_kind: 'custom_object', target_kind: 'organization', source_custom_object_id: id(11), cardinality: 'many_to_one' },
  ].map(d => ({ ...d, status: 'active', configuration: {} }));
  if (reverse) for (const d of relationships) {
    [d.source_kind, d.target_kind] = [d.target_kind, d.source_kind];
    d.target_custom_object_id = d.source_custom_object_id;
    d.source_custom_object_id = null;
    if (d.cardinality === 'many_to_one') d.cardinality = 'one_to_many';
  }
  return {
    config: { enabled: true, memberDepartmentDefinitionId: id(1), departmentOrganizationDefinitionId: id(2),
      secondaryMemberDefinitionId: id(3), secondaryOrganizationDefinitionId: id(4), secondaryLabelFieldId: null },
    metadata: { complete: true, relationships,
      objects: [{ id: id(10), status: 'active', primary_display_field_id: id(20) }, { id: id(11), status: 'active', primary_display_field_id: id(21) }],
      fields: { [id(10)]: [{ id: id(20), name: 'name', field_type: 'text' }], [id(11)]: [{ id: id(21), name: 'label', field_type: 'text' }] } },
  };
}
test('generic direct bindings support both orientations without tenant-specific identities', () => {
  for (const reversed of [false, true]) {
    const f = fixture(reversed);
    assert.equal(validateProfileAffiliationConfig(f.config, f.metadata).enabled, true);
  }
});
test('saved bindings pin endpoint directions, graph scopes, defaults and display semantics', () => {
  const f = fixture();
  const saved = validateProfileAffiliationConfig(f.config, f.metadata);
  assert.equal(validateProfileAffiliationConfig(saved, f.metadata, { requirePinned: true }).bindingSignature, saved.bindingSignature);
  f.metadata.fields[id(10)][0].name = 'replacement';
  assert.throws(() => validateProfileAffiliationConfig(saved, f.metadata, { requirePinned: true }), /definitions changed/);
});
test('BNMS-shaped scope must match complete primary plus secondary bindings exactly', () => {
  const f = fixture();
  f.metadata.relationships[0].configuration.picker_scope = {
    match: 'intersects', version: 2, source_path: [{ from_side: 'source', relationship_definition_id: id(2) }],
    target_path: [{ from_side: 'target', relationship_definition_id: id(3) }, { from_side: 'source', relationship_definition_id: id(4) }],
    target_terminal_sources: [{ type: 'core_field', field: 'organization_id' }],
  };
  assert.equal(validateProfileAffiliationConfig(f.config, f.metadata).enabled, true);
  assert.throws(() => validateProfileAffiliationConfig({ ...f.config, secondaryMemberDefinitionId: null, secondaryOrganizationDefinitionId: null }, f.metadata), /graph scope/);
  f.metadata.relationships[0].configuration.picker_scope.target_terminal_sources = [];
  assert.throws(() => validateProfileAffiliationConfig(f.config, f.metadata), /graph scope/);
});
test('incomplete, archived, incompatible, required-field and unsafe-default bindings fail closed', () => {
  for (const mutate of [
    f => { f.metadata.complete = false; },
    f => { f.metadata.relationships[0].status = 'archived'; },
    f => { f.metadata.relationships[0].cardinality = 'many_to_one'; },
    f => { f.metadata.relationships[1].source_custom_object_id = id(11); },
    f => { f.metadata.fields[id(11)] = [{ id: id(40), is_required: true }]; },
    f => { f.metadata.relationships[0].configuration.relationship_fields = [{ type: 'boolean', default: true }]; },
    f => { f.metadata.relationships[2].configuration.relationship_fields = [{ type: 'boolean', default: false }]; },
  ]) {
    const f = fixture(); mutate(f);
    assert.throws(() => validateProfileAffiliationConfig(f.config, f.metadata));
  }
});
test('omitted fields preserve, explicit clears survive, metadata and owner spoofing rejected', () => {
  assert.deepEqual(normalizeProfileAffiliationRequest({ token: id(1) }), {});
  assert.deepEqual(normalizeProfileAffiliationRequest({ token: id(1), primary: null, departments: [] }), { primary: null, departments: [] });
  for (const body of [
    { memberId: id(2) }, { tenant_id: id(2) }, { field_values: { survey_respondent: true } },
    { departments: [id(2), id(2)] }, { departments: null }, { primary: 'unlisted' },
  ]) assert.throws(() => normalizeProfileAffiliationRequest({ token: id(1), ...body }));
});
test('generic entity bypass denied without changing ordinary profile or administrator saves', async () => {
  const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
  const call = (body, admin = false) => rejectGenericAffiliationWrite({
    entity: 'Member', req: { method: 'PATCH', body }, res, context: { isAuthenticated: true }, hasAdminAccess: async () => admin,
  });
  assert.equal(await call({ organization_id: id(1) }), true);
  assert.equal(res.code, 403);
  assert.equal(await call({ data: [{ organization_id: null }] }), true);
  assert.equal(await call({ first_name: 'Fixture' }), false);
  assert.equal(await call({ organization_id: id(1) }, true), false);
});
