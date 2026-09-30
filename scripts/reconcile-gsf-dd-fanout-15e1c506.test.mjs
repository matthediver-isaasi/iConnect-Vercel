import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcile } from './reconcile-gsf-dd-fanout-15e1c506.mjs';

const event = '15e1c506-8ced-4c72-81ab-8eb07dd11f38';
const tenant = '21296ad6-1350-483a-a90c-1b06ece70501';
const org = 'ce1578e3-f700-417a-9816-683fee5b7561';
const field = '253a166d-1914-4ea0-a214-d3476dc97e14';
const levels = '24dd507a-43b4-45f8-a396-eb4b9b079f1d';
const flags = [
  'e0fa56c0-bcb2-4e76-9d60-2b066fadf993',
  '5258baff-8cc0-4d86-aec2-d79790e0cb0d',
  'de0fa76a-bfa1-4543-9eec-bb2015389c05',
];
const ids = [
  '31bde2ab-3966-401b-9bdd-f770764ed9ce',
  '4bdb2cbb-76c3-468b-9464-b768dd1bfe1a',
  '5912cb3e-27b5-414d-a105-69a83ea1697b',
  '69534af9-1c9e-4cf3-ba39-c59115c7e426',
  '80775fe1-1f75-4892-80eb-56edf1d3e3fa',
  'b9c7dfb0-172f-440b-82da-d582ebf9aa8f',
  'c17479a8-00a2-413d-8a30-c2a61e728cac',
  'd45ddf4e-4093-4f98-8ec8-b3eeaaf00a19',
  'd4fc3dc0-a61c-463d-aa1c-29a1f90233e5',
  'e3384f06-5fc2-49d5-a337-889be7280a0e',
];
const fingerprints = [
  '9f04b24116d2a3100fc631eab7e5a33f',
  '4c7dc2b94d38578eb25e929826dac8a9',
  'a5b21e7409f8fa84e9dca6035354b0b8',
  '697292eccc8273c70a1405c5cb68c0d3',
  '4d6451965ec29e683dc884911f1f5c8a',
  '0030bfdfcf44d7cecb32e5a5871b724f',
  'e49fdddad2801cf7a0de63c3bc29e227',
  'ec0faad198f182992e0dcf5c0024d71a',
  'f7ea2daa8cc857e276c99dd49945d774',
  'f541c9d046b0b84ae93dcca16a611677',
];
const expectedActions = {
  [ids[5]]: [flags[0], 'true'],
  [ids[9]]: [flags[0], 'false'],
  [ids[3]]: [flags[1], 'true'],
  [ids[1]]: [flags[1], 'false'],
  [ids[8]]: [flags[2], 'false'],
  [ids[6]]: [flags[2], 'true'],
};
const siblingFields = [
  '36d0817e-acb7-43f1-8590-531e19886b61', '84a15ff1-542a-442c-a8fc-4eb9585505e1',
  '62a6b407-22c8-43d8-b357-1c4e0bca6538', levels,
  'eff6f08f-bddc-4205-9cac-7251a11db368', 'bbc558ab-1782-4994-b70a-87939544828a',
  'a67cbbad-d0bc-4805-b98d-1d5d53d9f26a', '9cf870e4-6b3b-47d1-9233-a783135130b7',
  '81fe250c-ae91-477f-80d9-79e24033063d', '3c8cfcd5-c89b-4f8f-9e5a-aee47539d574',
  '45641770-9594-462e-b235-79316a11a1be', 'f2435ba9-9e15-4b02-bf47-c1f0aacf8ff6',
  '680f7943-f602-4da0-86b8-0fa01ac99218', 'd89bc293-99d1-455d-80c3-50efbad06add',
  'e2c271e7-b650-4438-8302-cf0c0155a1aa', 'c6abfa4f-9a54-49c6-8f62-68c0714d3a46',
  '077f1aa6-abdc-4bdc-a6ca-34b93c8726fd', 'c613c9be-8ae6-4201-b704-c5b24b24fe16',
  '79e723bd-f5ff-43aa-aa62-eec7f5c5c88f', 'b687c108-7ea5-450d-930d-7d5bf6b3acf0',
];
const numbers = ['12', '13', '14', '15', '16', '17', '18', '19', '21', '22',
  '23', '24', '25', '26', '27', '31', '32', '7', '8', '9'];
const pending = siblingFields.map((fieldId, index) => ({
  id: [
    '9652f714-917b-4169-bae2-e238eb3b0477', '8dfdec0b-fd50-4409-9993-6651de19c63b',
    '0dce0147-febb-43de-81d3-68d49f152d49', 'e07706c5-a652-40d6-b90f-986a164a3c5a',
    '64bf4db8-a38e-49fd-ac8f-dd4816885eae', 'ac09c787-fd0d-4680-aece-ed2c19a4a1d1',
    '98e94a65-a0b3-42d5-9c1c-180f8172ef42', 'f7d11935-2200-4a7e-bb8d-02460a1bff83',
    '8a734ac8-2326-423b-b4c6-8ee420563200', '2c0767f9-4c41-49ce-ae9b-ef6349703284',
    'fc3897f5-570b-4914-9510-2bf4d01314e5', '3ad6e060-559b-4de4-afc6-41ec65ec93bf',
    '56f87859-557d-4c9e-8c6b-d341a8d9a181', '88a1c4f2-010e-4f8d-8051-9583d55d1b01',
    'a78e883f-1030-4c9f-97c9-796e04035e04', '94a22077-a770-4ad4-80e3-8d2d48d39c12',
    '97ced59e-160d-4951-b147-4b0128adf027', '2e815929-d244-4102-b2d7-c8fe6ca0834d',
    '585d74e9-b786-4a59-82ef-bcd0997b3fe0', 'd10f7b70-7e5c-498d-8199-af38b475234b',
  ][index],
  tenant_id: tenant,
  form_submission_due_diligence_id: '93ac8bce-6ab3-4a8a-b40b-610652aaaf78',
  event_key: `preference:ded635a2-fb7a-48df-b6a3-14110c537885:${numbers[index]}`,
  event_type: 'preference', target_entity: 'organization', organization_id: org, member_id: null,
  status: 'pending', attempt_count: 0, completed_at: null,
  payload: { field_id: fieldId, new_value: fieldId === levels ? 'Grade 1' : 'sample',
    ...(numbers[index] === '32' ? { previous_value: 'before' } : {}) },
}));

function fixture(overrides = {}) {
  const calls = [];
  const workflowRows = ids.map((id, index) => ({
    id, fingerprint: fingerprints[index],
    trigger_type: index === 4 ? 'field_change' : [0, 2, 7].includes(index) ? 'record_create' : 'record_update',
    trigger_config: index === 4 ? { field_type: 'core', field_id: 'payment_status' } : {},
    conditions: [{ field_id: levels, field_type: 'org_custom', operator: id === ids[8] ? 'not_contains' : 'contains', value: id === ids[8] ? 'Grade 12' : 'Grade 1' }],
    actions: expectedActions[id] ? [{ type: 'update_field', config: {
      field_type: 'custom', field_id: expectedActions[id][0], value: expectedActions[id][1],
    } }] : [],
  }));
  // Nonmatching record-update rows must not be accidentally treated as matches.
  for (const index of [1, 6, 9]) workflowRows[index].conditions[0].value = 'Grade 12';
  workflowRows[1].conditions[0].operator = 'contains';
  workflowRows[6].conditions[0].operator = 'contains';
  workflowRows[9].conditions[0].operator = 'contains';
  const exact = {
      id: event, tenant_id: tenant, form_submission_due_diligence_id: '93ac8bce-6ab3-4a8a-b40b-610652aaaf78',
      event_key: 'preference:ded635a2-fb7a-48df-b6a3-14110c537885:11',
      event_type: 'preference', target_entity: 'organization', organization_id: org, member_id: null,
      payload: { field_id: field, new_value: 'not-a-boolean' }, status: 'requires_attention',
      attempt_count: 1, completed_at: null, last_error: 'interrupted and requires attention',
    };
  const responses = [
    [exact],
    [{
      delivery_key: `dd-field-mapping:${event}`, tenant_id: tenant, entity_type: 'organization',
      entity_id: org, status: 'processing', claimed_at: new Date(0), updated_at: new Date(0),
      owner_token: 'token', completed_at: null, last_error: null,
    }],
    [{ id: '93ac8bce-6ab3-4a8a-b40b-610652aaaf78', tenant_id: tenant,
      workflow_status: 'approved', stage_action_occurrence_id: '416e05f0-cd68-49a3-80c9-fb38260b487c' }],
    [{ id: org, tenant_id: tenant }],
    [exact, ...pending],
    [],
    [{ field_id: field, value: 'not-a-boolean' },
      ...pending.map(row => ({ field_id: row.payload.field_id, value: row.payload.new_value })),
      { field_id: flags[0], value: 'true' }, { field_id: flags[1], value: 'true' },
      { field_id: flags[2], value: 'false' }],
    [field, ...siblingFields, ...flags].map(id => ({ id, field_type: id === levels ? 'picklist' : 'boolean' })),
    workflowRows,
    [{ status: 'pending', event_type: 'preference', count: 20 }],
  ];
  for (const [index, modify] of Object.entries(overrides)) modify(responses[Number(index)]);
  let next = 0;
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (/^\s*(BEGIN|ROLLBACK|COMMIT|SET LOCAL)/.test(sql)) return { rows: [] };
      if (/^\s*UPDATE workflow_delivery_claim/.test(sql)) return { rows: [{ delivery_key: `dd-field-mapping:${event}` }] };
      if (/^\s*UPDATE form_due_diligence_field_mapping_workflow_outbox/.test(sql) && /WHERE id=\$1/.test(sql)) return { rows: [{ id: event }] };
      if (/^\s*INSERT INTO workflow_delivery_claim/.test(sql)) return { rows: pending.map(row => ({ delivery_key: `dd-field-mapping:${row.id}` })) };
      if (/^\s*UPDATE form_due_diligence_field_mapping_workflow_outbox/i.test(sql)) return { rows: pending.map(row => ({ id: row.id })) };
      assert(next < responses.length, 'unexpected query');
      return { rows: responses[next++] };
    },
  };
}

test('default dry run makes no changes and assesses siblings without dispatch', async () => {
  const db = fixture();
  const result = await reconcile(db);
  assert.equal(result.reconciled, false);
  assert.equal(result.matchedWorkflows.length, 3);
  assert.equal(result.siblings[0].count, 20);
  assert.equal(result.pendingSiblingsAssessed, 20);
  assert.equal(result.pendingSiblingsAcknowledged, 0);
  assert.equal(result.pendingSiblingsDispatched, false);
  assert.equal(db.calls.at(-1).sql, 'ROLLBACK');
  assert(!db.calls.some(call => /\bUPDATE\b/i.test(call.sql)));
});

test('apply acknowledges all 21 claim/outbox pairs atomically, without replay', async () => {
  const db = fixture();
  const result = await reconcile(db, { apply: true });
  assert.equal(result.reconciled, true);
  assert.equal(db.calls.at(-1).sql, 'COMMIT');
  assert.equal(result.pendingSiblingsAcknowledged, 20);
  assert.equal(db.calls.filter(call => /^\s*UPDATE/.test(call.sql)).length, 3);
  assert.equal(db.calls.filter(call => /^\s*INSERT/.test(call.sql)).length, 1);
  assert(db.calls.every(call => !/DELETE|triggerWorkflows|dispatch/i.test(call.sql)));
});

test('changed matching workflow configuration blocks writes and rolls back', async () => {
  const db = fixture({ 8: rows => { rows[5].fingerprint = 'changed'; } });
  await assert.rejects(reconcile(db, { apply: true }), /fingerprint changed/);
  assert.equal(db.calls.at(-1).sql, 'ROLLBACK');
  assert(!db.calls.some(call => /^\s*UPDATE/.test(call.sql)));
});

test('unsatisfied flag and occurrence change independently block acknowledgement', async () => {
  for (const changes of [
    { 6: rows => { rows.at(-3).value = 'false'; } },
    { 2: rows => { rows[0].stage_action_occurrence_id = 'changed'; } },
  ]) {
    const db = fixture(changes);
    await assert.rejects(reconcile(db, { apply: true }), /Guard failed/);
    assert.equal(db.calls.at(-1).sql, 'ROLLBACK');
    assert(!db.calls.some(call => /^\s*UPDATE/.test(call.sql)));
  }
});

test('pending sibling current-value mismatch, prior claim, or custom trigger blocks the whole batch', async () => {
  for (const changes of [
    { 6: rows => { rows[1].value = 'changed'; } },
    { 5: rows => { rows.push({ delivery_key: `dd-field-mapping:${pending[0].id}`, status: 'processing' }); } },
    { 8: rows => { rows[4].trigger_config = { field_type: 'custom', field_id: siblingFields[0] }; } },
  ]) {
    const db = fixture(changes);
    await assert.rejects(reconcile(db, { apply: true }), /Guard failed/);
    assert.equal(db.calls.at(-1).sql, 'ROLLBACK');
    assert(!db.calls.some(call => /^\s*(UPDATE|INSERT)/.test(call.sql)));
  }
});