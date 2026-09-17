import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  RETIRED_FIELD_ID,
  REPLACEMENT_FIELD_ID,
  ROW_OBJECT_ID,
  TENANT_ID,
  buildPlan,
  fingerprint,
  lockTableNames,
  sanitizePresentationConfiguration,
  verifyPostcondition,
} from './bnms-workforce-retire-year.mjs';

const scriptSource = await readFile(new URL('./bnms-workforce-retire-year.mjs', import.meta.url), 'utf8');

function field(id, name, is_active = true) {
  return {
    id, tenant_id: TENANT_ID, custom_object_id: ROW_OBJECT_ID, name,
    label: name, field_type: 'dropdown', is_active,
  };
}

function baseConfiguration() {
  return {
    views: {
      list: { field_ids: [REPLACEMENT_FIELD_ID] },
      detail: {
        version: 2,
        schema_field_ids: [RETIRED_FIELD_ID, REPLACEMENT_FIELD_ID],
        cards: [{
          id: 'card-details', title: 'Workforce Register Row details', columns: 2,
          fields: [
            { id: `custom:${RETIRED_FIELD_ID}`, type: 'custom', fieldId: RETIRED_FIELD_ID, columnIndex: 0 },
            { id: `custom:${REPLACEMENT_FIELD_ID}`, type: 'custom', fieldId: REPLACEMENT_FIELD_ID, columnIndex: 1 },
          ],
        }],
        visibility_rules: {
          version: 1,
          rules: [{
            id: 'old-rule',
            conditions: [{ field_id: RETIRED_FIELD_ID, operator: 'equals' }],
            actions: [{ action_type: 'show', target_type: 'field', target_field_id: RETIRED_FIELD_ID }],
          }],
        },
      },
      organisation_directory: { enabled: false, field_ids: [REPLACEMENT_FIELD_ID], relationships: [] },
    },
  };
}

function baseState() {
  const records = Array.from({ length: 8 }, (_, index) => ({
    id: `record-${index + 1}`, tenant_id: TENANT_ID, custom_object_id: ROW_OBJECT_ID,
    data: { [RETIRED_FIELD_ID]: `historic-${index + 1}`, notes: { preserved: true } },
    archived_at: null,
  }));
  const edges = records.map((row, index) => ({
    id: `edge-${index + 1}`, tenant_id: TENANT_ID, relationship_definition_id: 'direct-definition',
    source_record_id: row.id, target_record_id: `department-${index + 1}`,
    field_values: {}, archived_at: null,
  }));
  const object = {
    id: ROW_OBJECT_ID, tenant_id: TENANT_ID, object_key: 'workforce_survey_row',
    primary_display_field_id: REPLACEMENT_FIELD_ID, status: 'active', archived_at: null,
    configuration: baseConfiguration(),
  };
  return {
    tenantId: TENANT_ID,
    objects: [object],
    fields: [field(RETIRED_FIELD_ID, 'row_name'), field(REPLACEMENT_FIELD_ID, 'staff_group')],
    records, edges, definitions: [],
    activeFormReferences: [], activeRelationshipPreviewReferences: [],
    activeReportReferences: [], activeConfigReferences: [],
    auditHistoryReferences: ['audit-1'], historicalReferences: ['form-history-1'],
  };
}

test('focused sanitizer removes only known presentation references and preserves history', () => {
  const before = baseConfiguration();
  const result = sanitizePresentationConfiguration(before);
  assert.equal(result.changed, true);
  assert.ok(result.removedPaths.some((path) => path.includes('schema_field_ids')));
  assert.equal(JSON.stringify(result.configuration).includes(RETIRED_FIELD_ID), false);
  assert.deepEqual(before.views.detail.schema_field_ids, [RETIRED_FIELD_ID, REPLACEMENT_FIELD_ID]);
  assert.equal(result.configuration.views.detail.cards[0].fields.length, 1);
  assert.equal(result.configuration.views.detail.visibility_rules.rules.length, 0);
});

test('field reference detection covers prefixed values and reference keys', () => {
  const configuration = {
    views: {
      detail: {
        cards: [],
        unknown: {
          value: `custom:${RETIRED_FIELD_ID}`,
          nested: { [`field:${RETIRED_FIELD_ID}`]: true },
        },
      },
    },
  };
  const state = baseState();
  state.objects[0].configuration = configuration;
  assert.throws(() => buildPlan(state), /unknown workforce presentation configuration path/);
});

test('mixed visibility rules retain unrelated live clauses while removing retired clauses', () => {
  const configuration = baseConfiguration();
  configuration.views.detail.visibility_rules.rules.push({
    id: 'mixed-rule',
    conditions: [
      { field_id: RETIRED_FIELD_ID, operator: 'equals' },
      { field_id: REPLACEMENT_FIELD_ID, operator: 'equals' },
    ],
    actions: [
      { action_type: 'show', target_type: 'field', target_field_id: RETIRED_FIELD_ID },
      { action_type: 'show', target_type: 'field', target_field_id: REPLACEMENT_FIELD_ID },
    ],
  });
  const result = sanitizePresentationConfiguration(configuration);
  const mixed = result.configuration.views.detail.visibility_rules.rules
    .find((rule) => rule.id === 'mixed-rule');
  assert.ok(mixed);
  assert.deepEqual(mixed.conditions, [{ field_id: REPLACEMENT_FIELD_ID, operator: 'equals' }]);
  assert.deepEqual(mixed.actions, [
    { action_type: 'show', target_type: 'field', target_field_id: REPLACEMENT_FIELD_ID },
  ]);
  assert.equal(JSON.stringify(result.configuration).includes(RETIRED_FIELD_ID), false);
});

test('plan changes metadata only, even when historical row JSON contains retired key', () => {
  const state = baseState();
  const beforeRecords = fingerprint(state.records);
  const beforeEdges = fingerprint(state.edges);
  const plan = buildPlan(state);
  assert.equal(plan.summary.recordsUpdated, 0);
  assert.equal(plan.summary.edgesUpdated, 0);
  assert.equal(plan.deactivateFieldId, RETIRED_FIELD_ID);
  assert.equal(plan.setPrimaryDisplayFieldId, null);
  assert.equal(fingerprint(state.records), beforeRecords);
  assert.equal(fingerprint(state.edges), beforeEdges);
  assert.equal(plan.configuration.views.detail.schema_field_ids.includes(RETIRED_FIELD_ID), false);
});

test('unknown active form, relationship-preview, report, and config refs fail closed', () => {
  for (const key of ['activeFormReferences', 'activeRelationshipPreviewReferences',
    'activeReportReferences', 'activeConfigReferences']) {
    const state = baseState();
    state[key] = [{ source: key, id: 'ref-1', path: 'configuration.unknown' }];
    assert.throws(() => buildPlan(state), /Active workforce metadata references retired field/);
  }
});

test('primary display is planned before deactivation when it has not already moved', () => {
  const state = baseState();
  state.objects[0].primary_display_field_id = RETIRED_FIELD_ID;
  const plan = buildPlan(state);
  assert.equal(plan.setPrimaryDisplayFieldId, REPLACEMENT_FIELD_ID);
  assert.equal(plan.deactivateFieldId, RETIRED_FIELD_ID);
});

test('replay is a zero-write plan after metadata has been applied', () => {
  const state = baseState();
  const initial = buildPlan(state);
  state.objects[0].configuration = initial.configuration;
  state.fields.find((row) => row.id === RETIRED_FIELD_ID).is_active = false;
  const replay = buildPlan(state);
  assert.equal(replay.completed, true);
  assert.equal(replay.summary.writes, 0);
  assert.deepEqual(verifyPostcondition(state, state, replay), {
    completed: true, recordsPreserved: true, edgesPreserved: true, historicalDataPreserved: true,
  });
});

test('destination transport is TLS-pinned and apply has no record or edge writes', () => {
  assert.match(scriptSource, /prod-ca-2021\.crt/);
  assert.match(scriptSource, /rejectUnauthorized: true/);
  assert.match(scriptSource, /servername: destination\.hostname/);
  assert.match(scriptSource, /DESTINATION_PROJECT_SUFFIX/);
  assert.match(scriptSource, /destination\.searchParams\.delete\(key\)/);
  assert.match(scriptSource, /const caResponse = await fetch\(DESTINATION_CA_URL\)/);
  assert.match(scriptSource, /SET is_active = false/);
  assert.doesNotMatch(scriptSource, /DELETE\s+FROM\s+public\.(?:custom_object_record|custom_object_relationship)/i);
  assert.doesNotMatch(scriptSource, /UPDATE\s+public\.custom_object_record/i);
  assert.doesNotMatch(scriptSource, /UPDATE\s+public\.custom_object_relationship\s/i);
  assert.match(scriptSource, /Set the replacement primary display first/);
});

test('apply lock setup reads reference tables from the returned snapshot state wrapper', () => {
  const snapshot = {
    state: { existingReferenceTables: ['form', 'system_settings'] },
  };
  assert.deepEqual(lockTableNames(snapshot), [
    'custom_object_definition',
    'preference_field',
    'custom_object_record',
    'custom_object_relationship',
    'custom_object_relationship_definition',
    'form',
    'system_settings',
  ]);
  // The compatibility fallback also protects callers holding the prior
  // wrapper shape, while the actual loadSnapshot shape is tested above.
  assert.deepEqual(lockTableNames({ existingReferenceTables: ['report'] }).at(-1), 'report');
  assert.doesNotMatch(scriptSource, /\.\.\.snapshot\.existingReferenceTables/);
});
