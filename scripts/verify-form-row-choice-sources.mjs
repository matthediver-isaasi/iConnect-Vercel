/**
 * Read-only verification of a three-column row source against DEST.
 * Usage: node scripts/verify-form-row-choice-sources.mjs \
 *   --parent-object=<uuid> --related-object=<uuid> --value-field=<field-name>
 *
 * Configuration exists only in memory. This script never saves a form, creates
 * a submission, or changes catalogue data. Output contains counts, not answers.
 */
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { createFormRelationshipService } from '../api/_lib/formRelationshipOptions.js';
import { validateRepeatableRowSubmission } from '../api/_lib/formRepeatableRowValidation.js';
import { rowSourceDependencyIds } from '../shared/formCustomObjectRowSources.js';

const args = Object.fromEntries(process.argv.slice(2).map(arg => {
  const split = arg.indexOf('=');
  if (!arg.startsWith('--') || split < 0) throw new Error('Expected --name=value arguments');
  return [arg.slice(2, split), arg.slice(split + 1)];
}));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
assert.ok(uuid.test(args['parent-object']), '--parent-object must be a UUID');
assert.ok(uuid.test(args['related-object']), '--related-object must be a UUID');
assert.ok(args['value-field'], '--value-field is required');
assert.ok(process.env.DEST_SUPABASE_URL && process.env.DEST_SUPABASE_KEY, 'DEST connection is required');
const db = createClient(process.env.DEST_SUPABASE_URL, process.env.DEST_SUPABASE_KEY, {
  auth: { persistSession: false },
});
const checked = async query => {
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data;
};
const objects = await checked(db.from('custom_object_definition')
  .select('id,tenant_id,primary_display_field_id,status')
  .in('id', [args['parent-object'], args['related-object']]).eq('status', 'active'));
const parentObject = objects.find(object => object.id === args['parent-object']);
const relatedObject = objects.find(object => object.id === args['related-object']);
assert.ok(parentObject && relatedObject, 'Both objects must be active');
assert.equal(parentObject.tenant_id, relatedObject.tenant_id, 'Objects must share one tenant');
const tenantId = parentObject.tenant_id;
const projectedFields = await checked(db.from('preference_field')
  .select('id,name,field_type').eq('tenant_id', tenantId)
  .eq('custom_object_id', relatedObject.id).eq('entity_scope', 'custom_object')
  .eq('name', args['value-field']).eq('is_active', true));
assert.equal(projectedFields.length, 1, 'Projection must identify one active field');
const relatedRecordCount = await db.from('custom_object_record')
  .select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId)
  .eq('custom_object_id', relatedObject.id).is('archived_at', null);
if (relatedRecordCount.error) throw new Error(relatedRecordCount.error.message);
const definitions = await checked(db.from('custom_object_relationship_definition')
  .select('id,source_kind,target_kind,source_custom_object_id,target_custom_object_id,show_on_source,show_on_target')
  .eq('tenant_id', tenantId).eq('status', 'active')
  .order('id').limit(1000));
const matches = definitions.flatMap(definition => ['source', 'target'].flatMap(side => {
  const other = side === 'source' ? 'target' : 'source';
  return definition[`${side}_kind`] === 'custom_object'
    && definition[`${side}_custom_object_id`] === parentObject.id
    && definition[`${other}_custom_object_id`] === relatedObject.id
    && definition[`show_on_${side}`] !== false
    ? [{ definition, side }] : [];
}));
assert.equal(matches.length, 1, 'Expected one visible active relationship');
const { definition, side } = matches[0];
const source = (object, kind = 'records') => ({
  version: 1, kind, custom_object_id: object.id,
  primary_display_field_id: object.primary_display_field_id, filters: [],
});
const columnIds = [1, 2, 3].map(number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`);
const first = { id: columnIds[0], type: 'relationship_dropdown', label: 'Type', option_source: source(parentObject) };
const relationship = {
  parent_field_id: first.id, parent_field_scope: 'row',
  relationship_definition_id: definition.id, relationship_parent_side: side,
  relationship_parent_kind: 'custom_object', relationship_parent_custom_object_id: parentObject.id,
  related_kind: 'custom_object', related_custom_object_id: relatedObject.id,
  related_primary_display_field_id: relatedObject.primary_display_field_id,
};
const second = {
  id: columnIds[1], type: 'relationship_dropdown', label: 'Distinct value', ...relationship,
  option_source: { ...source(relatedObject, 'distinct'), value_field_id: projectedFields[0].id },
};
const third = {
  id: columnIds[2], type: 'relationship_dropdown', label: 'Related record', ...relationship,
  option_source: { ...source(relatedObject), filters: [{ field_id: projectedFields[0].id, source_field_id: second.id }] },
};
const children = [first, second, third];
const container = { id: 'verification-rows', type: 'repeatable_rows', repeatable_row: { children } };
const rootForm = { fields: [container], tenant_id: tenantId };
const service = createFormRelationshipService({ db, tenantId });
async function options(field, answers = {}) {
  const result = [];
  for (let page = 1; ; page += 1) {
    const payload = await service.relationshipOptions({
      form: { fields: children }, rootForm, containerFieldId: container.id,
      fieldId: field.id,
      dependencyAnswers: Object.fromEntries(rowSourceDependencyIds(field).map(id => [id, answers[id]])),
      query: { page, pageSize: 100 },
    });
    assert.ok(payload.data.every(option => Object.keys(option).sort().join(',') === 'id,label'));
    result.push(...payload.data);
    if (result.length >= payload.total) return result;
    assert.ok(payload.data.length, 'Pagination cannot stop before total');
  }
}
const parentOptions = await options(first);
assert.ok(parentOptions.length, 'Expected parent records');
const totals = [];
let representative;
for (const parent of parentOptions) {
  const scalarOptions = await options(second, { [first.id]: parent.id });
  assert.equal(new Set(scalarOptions.map(option => option.id)).size, scalarOptions.length);
  assert.ok(scalarOptions.every(option => option.id === option.label && option.id.trim()));
  let recordCount = 0;
  for (const scalar of scalarOptions) {
    const answers = { [first.id]: parent.id, [second.id]: scalar.id };
    const records = await options(third, answers);
    assert.ok(records.length);
    assert.ok(records.every(record => uuid.test(record.id)));
    recordCount += records.length;
    representative ||= { ...answers, [third.id]: records[0].id };
  }
  totals.push({ distinctValues: scalarOptions.length, records: recordCount });
}
assert.ok(representative, 'Expected at least one eligible complete row');
await validateRepeatableRowSubmission({
  db, tenantId, form: rootForm,
  submissionData: { [container.id]: [{ _row_id: 'verification-row', ...representative }] },
});
await assert.rejects(validateRepeatableRowSubmission({
  db, tenantId, form: rootForm,
  submissionData: { [container.id]: [{ _row_id: 'verification-row', ...representative, [second.id]: '__invalid_scalar__' }] },
}));
console.log(JSON.stringify({
  parentRecords: parentOptions.length, activeRelatedRecords: relatedRecordCount.count, perParent: totals,
  matchingRecords: totals.reduce((sum, item) => sum + item.records, 0),
  validSubmissionAccepted: true, forgedScalarRejected: true, writes: 0,
}));