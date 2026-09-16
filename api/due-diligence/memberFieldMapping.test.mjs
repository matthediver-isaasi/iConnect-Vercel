import test from 'node:test';
import assert from 'node:assert/strict';
import { supabase } from '../_lib/database.js';
import { __testables } from './_stageActions.js';

test('member mappings preserve reviewed clears instead of silently skipping them', () => {
  const resolved = __testables.resolveStageMappingSource({
    source_field_id: 'phone',
    source_type: 'form_field',
    transformation: 'none',
  }, {
    originalData: { phone: '+64 4 000 0000' },
    reviewedData: { phone: '' },
    fieldReviewStatus: { phone: 'amended' },
    sourceFormFields: [],
  });

  assert.equal(resolved.source, 'amended');
  assert.equal(resolved.value, '');
  assert.equal(resolved.explicitEmpty, true);
});

test('member core values retain their string storage representation', () => {
  assert.equal(__testables.coerceMemberCoreMappingValue('Ada', 'first_name'), 'Ada');
  assert.equal(__testables.coerceMemberCoreMappingValue('2026-10-25', 'mobile'), '2026-10-25');
  assert.equal(__testables.coerceMemberCoreMappingValue('2026-10-25', 'job_title'), '2026-10-25');
});

test('member mappings apply configured transformations before storage coercion', () => {
  const resolved = __testables.resolveStageMappingSource({
    source_field_id: 'name',
    source_type: 'form_field',
    transformation: 'uppercase',
  }, {
    originalData: { name: 'Ada Lovelace' },
    reviewedData: {},
    fieldReviewStatus: {},
    sourceFormFields: [],
  });

  assert.equal(resolved.value, 'ADA LOVELACE');
  assert.equal(resolved.source, 'original');
});

test('member execution persists core and custom values through the member-scoped atomic RPC', async () => {
  const originalFrom = supabase.from;
  const originalRpc = supabase.rpc;
  const rpcCalls = [];
  const checkpoints = [];
  const member = {
    id: 'member-1',
    tenant_id: 'tenant-1',
    first_name: 'Old',
    show_in_directory: true,
  };
  let customRead = null;

  supabase.from = (table) => {
    let operation = 'read';
    let mutation = null;
    const filters = {};
    const query = {
      select() { return query; },
      eq(key, value) { filters[key] = value; return query; },
      in() { return query; },
      update(value) { operation = 'update'; mutation = value; return query; },
      single() { return response(); },
      maybeSingle() { return response(); },
      then(resolve) { return resolve(response()); },
    };
    const response = () => {
      if (table === 'member') return { data: { ...member }, error: null };
      if (table === 'preference_field') {
        return {
          data: [{ id: 'pref-1', field_type: 'boolean', entity_scope: 'member', is_active: true }],
          error: null,
        };
      }
      if (table === 'member_preference_value') {
        if (operation === 'update' && mutation) customRead = mutation.value;
        return { data: customRead ? { id: 'value-1', value: customRead } : null, error: null };
      }
      if (table === 'form_submission_due_diligence' && operation === 'read') {
        return { data: { history_log: [] }, error: null };
      }
      return { data: null, error: null };
    };
    return query;
  };
  supabase.rpc = async (name, args) => {
    assert.equal(name, 'apply_form_due_diligence_field_mapping_with_outbox');
    rpcCalls.push(args);
    if (args.p_event_type === 'core') {
      return {
        data: {
          applied: true,
          after: { ...member, ...args.p_mutation },
        },
        error: null,
      };
    }
    return { data: { applied: true }, error: null };
  };

  try {
    const results = await __testables.executeMemberFieldMappingActions({
      memberActions: [{
        id: 'action-1',
        target_entity: 'member',
        tenant_id: 'tenant-1',
        form_id: 'form-1',
        due_diligence_stage_id: 'approved',
        field_mappings: [
          { source_type: 'form_field', source_field_id: 'first', target_type: 'core', target_field: 'first_name' },
          { source_type: 'form_field', source_field_id: 'executive', target_type: 'custom', target_field: 'pref-1' },
        ],
      }],
      formSubmission: {
        form_id: 'form-1',
        submission_data: { first: 'New', executive: 'No' },
        organization_id: null,
        created_member_id: 'member-1',
        member_id: 'wrong-member',
      },
      ddSubmission: {
        id: 'dd-1',
        form_id: 'form-1',
        updated_at: 'history-write-1',
        stage_action_occurrence_id: 'transition-1',
        reviewed_form_values: {},
        field_review_status: {},
      },
      tenantId: 'tenant-1',
      triggeredBy: 'test',
      options: {
        onActionCompleted: async (key) => checkpoints.push(key),
      },
      sourceFormFields: [
        { id: 'first', name: 'first' },
        { id: 'executive', name: 'executive' },
      ],
      originalData: { first: 'New', executive: 'No' },
      reviewedData: {},
      fieldReviewStatus: {},
    });

    assert.equal(results[0].status, 'success');
    assert.deepEqual(rpcCalls.map((call) => ({
      entity: call.p_target_entity,
      member: call.p_member_id,
      type: call.p_event_type,
      eventKey: call.p_event_key,
      mutation: call.p_mutation,
      value: call.p_preference_value,
    })), [
      {
        entity: 'member',
        member: 'member-1',
        type: 'core',
        eventKey: 'core:member:transition-1:action-1:0',
        mutation: { first_name: 'New' },
        value: null,
      },
      {
        entity: 'member',
        member: 'member-1',
        type: 'preference',
        eventKey: 'preference:member:transition-1:action-1:1',
        mutation: {},
        value: 'false',
      },
    ]);
    assert.deepEqual(checkpoints, ['field_mapping:action-1']);
  } finally {
    supabase.from = originalFrom;
    supabase.rpc = originalRpc;
  }
});