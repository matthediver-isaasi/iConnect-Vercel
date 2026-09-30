import test from 'node:test';
import assert from 'node:assert/strict';
import { supabase } from '../_lib/database.js';
import { executeFieldMappingActions } from './_stageActions.js';
import {
  durableDeliveryOutcomeError,
  triggerWorkflows,
  workflowEmailActionResult,
} from '../_lib/workflows.js';
import { dispatchFieldMappingWorkflowFanouts } from './fieldMappingWorkflowFanout.js';

function createFieldMappingClient(state) {
  return {
    from(table) {
      let operation = 'read';
      let mutation = null;
      let selected = false;
      const filters = {};
      const query = {
        select() { selected = true; return query; },
        eq(column, value) { filters[column] = value; return query; },
        in(column, values) { filters[column] = values; return query; },
        order() { return query; },
        update(value) { operation = 'update'; mutation = value; return query; },
        upsert(value) { operation = 'upsert'; mutation = value; return query; },
        insert(value) { operation = 'insert'; mutation = value; return query; },
        single() { return response(); },
        maybeSingle() { return response(); },
        then(resolve) { return resolve(response()); },
      };
      const response = () => {
        if (table === 'form_submission') {
          return { data: {
            form_id: 'form',
            organization_id: 'organization',
            submission_data: state.answers || {},
          }, error: null };
        }
        if (table === 'stage_field_mapping_action') {
          return { data: [state.mappingAction || {
            id: 'mapping',
            field_mappings: [{
              source_type: 'static',
              static_value: 'Renamed organization',
              target_type: 'core',
              target_field: 'name',
            }],
          }], error: null };
        }
        if (table === 'organization') {
          if (operation === 'read' && state.snapshotError) {
            return { data: null, error: state.snapshotError };
          }
          if (operation === 'update') {
            if (state.failCoreField && Object.hasOwn(mutation, state.failCoreField)) {
              return { data: null, error: { message: `temporary ${state.failCoreField} write failure` } };
            }
            Object.assign(state.organization, mutation);
          }
          return { data: operation === 'read' ? { ...state.organization } : null, error: null };
        }
        if (table === 'tenant') return { data: { slug: 'tenant' }, error: null };
        if (table === 'form') return { data: state.sourceForm || { fields: [] }, error: null };
        if (table === 'workflow') return { data: state.workflows || [], error: null };
        if (table === 'workflow_log') {
          if (operation === 'insert') (state.workflowLogs ||= []).push(mutation);
          return { data: null, error: null };
        }
        if (table === 'workflow_delivery_claim') {
          state.workflowClaims ||= [];
          if (operation === 'insert') {
            const duplicate = state.workflowClaims.find((row) => row.delivery_key === mutation.delivery_key);
            if (duplicate) return { data: null, error: { code: '23505', message: 'duplicate claim' } };
            state.workflowClaims.push({ ...mutation });
            return { data: selected ? { ...mutation } : null, error: null };
          }
          if (operation === 'update') {
            const claim = state.workflowClaims.find((row) => (
              row.delivery_key === filters.delivery_key
              && (!filters.owner_token || row.owner_token === filters.owner_token)
              && (!filters.status || row.status === filters.status)
            ));
            if (claim) Object.assign(claim, mutation);
            return { data: selected && claim ? { delivery_key: claim.delivery_key } : null, error: null };
          }
          return {
            data: state.workflowClaims.find((row) => Object.entries(filters).every(([key, value]) => row[key] === value)) || null,
            error: null,
          };
        }
        if (table === 'preference_field') {
          const fields = state.preferenceFields || [];
          return {
            data: state.enforcePreferenceTenant
              ? fields.filter((field) => field.tenant_id === filters.tenant_id)
              : fields,
            error: null,
          };
        }
        if (table === 'form_submission_due_diligence') {
          if (operation === 'update') state.history = mutation.history_log;
          return { data: { history_log: state.history || [] }, error: null };
        }
        if (table === 'form_due_diligence_field_mapping_workflow_outbox') {
          if (operation === 'upsert') {
            if (!state.outbox.some((row) => row.event_key === mutation.event_key)) {
              state.outbox.push({
                id: `event-${state.outbox.length + 1}`,
                status: 'pending',
                attempt_count: 0,
                ...mutation,
              });
            }
            return { data: null, error: null };
          }
          if (operation === 'update') {
            const row = state.outbox.find((item) => (
              item.id === filters.id
              && item.tenant_id === filters.tenant_id
              && item.form_submission_due_diligence_id === filters.form_submission_due_diligence_id
              && (!filters.event_key || item.event_key === filters.event_key)
              && (!filters.target_entity || item.target_entity === filters.target_entity)
              && (!filters.member_id || item.member_id === filters.member_id)
              && (!filters.organization_id || item.organization_id === filters.organization_id)
            ));
            if (selected && filters.status === 'pending') state.onClaim?.(row);
            if (!row || (filters.status && !(Array.isArray(filters.status) ? filters.status.includes(row.status) : row.status === filters.status))) {
              return { data: null, error: null };
            }
            Object.assign(row, mutation);
            return { data: selected ? { id: row.id } : null, error: null };
          }
          return {
            data: state.outbox.filter((row) => (
              row.form_submission_due_diligence_id === filters.form_submission_due_diligence_id
              && row.tenant_id === filters.tenant_id
              && (!filters.status || filters.status.includes(row.status))
            )).map((row) => ({ ...row })),
            error: null,
          };
        }
        return { data: null, error: null };
      };
      return query;
    },
  };
}

async function withFieldMappingClient(state, callback) {
  const originalFrom = supabase.from;
  const originalRpc = supabase.rpc;
  supabase.from = createFieldMappingClient(state).from;
  supabase.rpc = async (name, args) => {
    if (name !== 'apply_form_due_diligence_field_mapping_with_outbox') {
      return { data: null, error: { message: `Unexpected RPC ${name}` } };
    }
    if (state.atomicFailure) {
      return { data: null, error: { message: state.atomicFailure } };
    }
    const addOutbox = (eventType, payload) => {
      if (!state.outbox.some((row) => row.event_key === args.p_event_key)) {
        state.outbox.push({
          id: `event-${state.outbox.length + 1}`,
          status: 'pending',
          attempt_count: 0,
          form_submission_due_diligence_id: args.p_due_diligence_submission_id,
          tenant_id: args.p_tenant_id,
          event_key: args.p_event_key,
          event_type: eventType,
          organization_id: args.p_organization_id,
          payload,
        });
      }
    };
    if (args.p_event_type === 'core') {
      if (state.failCoreField && Object.hasOwn(args.p_mutation, state.failCoreField)) {
        return { data: null, error: { message: `temporary ${state.failCoreField} write failure` } };
      }
      const before = { ...state.organization };
      const changed = Object.entries(args.p_mutation)
        .some(([key, value]) => state.organization[key] !== value);
      if (!changed) return { data: { applied: false, created: false, after: before }, error: null };
      Object.assign(state.organization, args.p_mutation);
      const after = { ...state.organization };
      addOutbox('core', { before, after });
      return { data: { applied: true, created: false, before, after }, error: null };
    }
    state.preferenceValues ||= new Map();
    const previous = state.preferenceValues.get(args.p_preference_field_id);
    if (previous === args.p_preference_value) {
      return { data: { applied: false, created: false }, error: null };
    }
    const created = !state.preferenceValues.has(args.p_preference_field_id);
    state.preferenceValues.set(args.p_preference_field_id, args.p_preference_value);
    addOutbox('preference', {
      field_id: args.p_preference_field_id,
      previous_value: previous,
      new_value: args.p_preference_value,
    });
    return { data: { applied: true, created }, error: null };
  };
  try {
    return await callback();
  } finally {
    supabase.from = originalFrom;
    supabase.rpc = originalRpc;
  }
}

const ddSubmission = { id: 'dd', form_submission_id: 'submission' };

function fanoutRow(overrides = {}) {
  return {
    id: 'event-1',
    event_key: 'core:mapping:0',
    event_type: 'core',
    target_entity: 'organization',
    organization_id: 'organization',
    form_submission_due_diligence_id: 'dd',
    tenant_id: 'tenant',
    status: 'pending',
    attempt_count: 0,
    payload: { before: { name: 'Before' }, after: { name: 'After' } },
    ...overrides,
  };
}

const dispatchOptions = (dependencies) => ({
  dueDiligenceSubmissionId: 'dd',
  tenantId: 'tenant',
  baseUrl: 'https://tenant.example',
  dependencies,
});

function assertFanoutError(error, row, status) {
  assert.equal(error.ddAmbiguousEffect || error.ddKnownQueryFailure, true);
  assert.deepEqual(error.ddFanout, {
    event_id: row.id,
    event_key: row.event_key,
    delivery_key: `dd-field-mapping:${row.id}`,
    status,
  });
  assert.equal(JSON.stringify(error.ddFanout).includes('before'), false);
  return true;
}

test('organization optional blanks preserve destinations and produce no workflow effects', async () => {
  const blanks = new Map([[1, 'address.line2'], [6, 'linkedin'], [20, 'demographic'], [28, 'overview']]);
  const state = {
    organization: { id: 'organization', tenant_id: 'tenant', name: 'Retained', address: { line2: 'Retained' } },
    preferenceFields: [...blanks.values()].filter(v => !v.includes('.')).map(id => ({ id, label: id })),
    sourceForm: { fields: [...blanks.keys()].map(index => ({ id: `field_${index}`, required: false })) },
    mappingAction: { id: 'mapping', field_mappings: Array.from({ length: 33 }, (_, index) => (
      blanks.has(index)
        ? { source_field_id: `field_${index}`, target_type: index === 1 ? 'core' : 'custom', target_field: blanks.get(index) }
        : { source_type: 'static', static_value: 'Retained', target_type: 'core', target_field: 'name' }
    )) },
    outbox: [],
  };
  const original = structuredClone(state.organization);
  await withFieldMappingClient(state, async () => {
    const results = await executeFieldMappingActions('approved', ddSubmission, 'tenant', 'system', {
      workflowFanoutDependencies: {
        triggerWorkflows: async () => assert.fail('no workflow should run'),
        triggerPreferenceWorkflows: async () => assert.fail('no preference workflow should run'),
      },
    });
    assert.equal(results[0].status, 'success');
    assert.equal(results[0].mappings.filter(m => m.status === 'skipped').length, 4);
    assert.deepEqual(state.organization, original);
    assert.equal(state.outbox.length, 0);
    assert.deepEqual(state.history.at(-1).details, {
      mappings_count: 0, applied_count: 0, skipped_count: 4, attention_count: 0, noop_count: 29,
      organization_id: 'organization',
    });
  });
});

test('organization all optional blank versus required, missing definition and invalid target', async () => {
  for (const scenario of ['optional', 'required', 'missing', 'invalid']) {
    const state = {
      organization: { id: 'organization', tenant_id: 'tenant', name: 'Retained' },
      sourceForm: { fields: scenario === 'missing' ? [] : [{ id: 'source', required: scenario === 'required' }] },
      answers: { source: [] },
      mappingAction: { id: 'mapping', field_mappings: [{
        source_field_id: 'source', target_type: 'core', target_field: scenario === 'invalid' ? 'not_a_column' : 'name',
      }] },
      outbox: [],
    };
    await withFieldMappingClient(state, async () => {
      const results = await executeFieldMappingActions('approved', ddSubmission, 'tenant', 'system');
      assert.equal(results[0].status, scenario === 'optional' ? 'success' : 'partial');
      assert.equal(state.organization.name, 'Retained');
      assert.equal(state.outbox.length, 0);
    });
  }
});

test('an optional skip cannot hide a genuine organization write failure', async () => {
  const state = {
    organization: { id: 'organization', tenant_id: 'tenant', name: 'Retained' },
    sourceForm: { fields: [{ id: 'source', required: false }] },
    mappingAction: { id: 'mapping', field_mappings: [
      { source_field_id: 'source', target_type: 'core', target_field: 'address.line2' },
      { source_type: 'static', static_value: 'Changed', target_type: 'core', target_field: 'name' },
    ] },
    failCoreField: 'name',
    outbox: [],
  };
  await withFieldMappingClient(state, async () => {
    const results = await executeFieldMappingActions('approved', ddSubmission, 'tenant', 'system');
    assert.equal(results[0].status, 'partial');
    assert.deepEqual(results[0].mappings.map(m => m.status), ['skipped', 'error']);
    assert.equal(state.history.at(-1).details.attention_count, 1);
    assert.equal(state.history.at(-1).details.skipped_count, 1);
    assert.equal(state.outbox.length, 0);
  });
});

test('organization false and zero are written, not skipped as empty answers', async () => {
  for (const value of [false, 0]) {
    const state = {
      organization: { id: 'organization', tenant_id: 'tenant', name: 'Retained' },
      sourceForm: { fields: [{ id: 'source', required: false }] },
      answers: { source: value },
      mappingAction: { id: 'mapping', field_mappings: [{
        source_field_id: 'source', target_type: 'core', target_field: 'name',
      }] },
      outbox: [],
    };
    await withFieldMappingClient(state, async () => {
      const results = await executeFieldMappingActions('approved', ddSubmission, 'tenant', 'system', {
        workflowFanoutDependencies: { triggerWorkflows: async () => ({ delivery: { status: 'completed' } }) },
      });
      assert.equal(results[0].status, 'success');
      assert.equal(results[0].mappings[0].status, 'updated');
      assert.equal(state.organization.name, String(value));
      assert.equal(state.outbox.length, 1);
      assert.equal(state.history.at(-1).details.applied_count, 1);
    });
  }
});

test('requires_attention keeps its original recorded reason and row untouched', async () => {
  const row = fanoutRow({
    status: 'requires_attention',
    last_error: 'original workflow delivery uncertainty',
    attempt_count: 2,
  });
  const state = { outbox: [row] };
  const original = structuredClone(row);
  let calls = 0;
  await withFieldMappingClient(state, async () => {
    await assert.rejects(dispatchFieldMappingWorkflowFanouts(dispatchOptions({
      triggerWorkflows: async () => { calls += 1; },
    })), (error) => {
      assertFanoutError(error, row, 'requires_attention');
      assert.equal(error.ddFanoutRecordedReason, original.last_error);
      assert.equal(error.message.includes(original.last_error), false);
      return true;
    });
  });
  assert.deepEqual(row, original);
  assert.equal(calls, 0);
});

test('member event diagnostics expose the occurrence without changing the event key or payload', async () => {
  const row = fanoutRow({
    status: 'requires_attention',
    event_key: 'preference:member:transition-123:action-456:0',
    event_type: 'preference',
    target_entity: 'member',
    member_id: 'member',
    payload: { field_id: 'field', new_value: 'private value', previous_value: null },
    last_error: 'original delivery uncertainty',
  });
  const original = structuredClone(row);
  await withFieldMappingClient({ outbox: [row] }, async () => {
    await assert.rejects(dispatchFieldMappingWorkflowFanouts(dispatchOptions({
      triggerPreferenceWorkflows: async () => { throw new Error('must not replay'); },
    })), (error) => {
      assert.deepEqual(error.ddFanout, {
        event_id: row.id,
        event_key: original.event_key,
        delivery_key: `dd-field-mapping:${row.id}`,
        status: 'requires_attention',
        stage_action_occurrence_id: 'transition-123',
      });
      assert.equal(JSON.stringify(error.ddFanout).includes('private value'), false);
      assert.equal(error.ddFanoutRecordedReason, original.last_error);
      return true;
    });
  });
  assert.deepEqual(row, original);
});

test('processing rows are blocked without reclaiming, replaying, or rewriting their state', async () => {
  for (const last_error of [null, 'interrupted worker original reason']) {
    const row = fanoutRow({ status: 'processing', attempt_count: 3, last_error });
    const state = { outbox: [row] };
    const original = structuredClone(row);
    let calls = 0;
    await withFieldMappingClient(state, async () => {
      await assert.rejects(dispatchFieldMappingWorkflowFanouts(dispatchOptions({
        triggerWorkflows: async () => { calls += 1; },
      })), (error) => assertFanoutError(error, row, 'processing'));
    });
    assert.deepEqual(row, original);
    assert.equal(calls, 0);
  }
});

test('completed claim reconciles stranded outbox without replay, for core and member preference', async () => {
  for (const status of ['processing', 'requires_attention']) {
    for (const target of ['organization', 'member']) {
      const row = fanoutRow({
        status, last_error: 'prior uncertainty',
        ...(target === 'member' ? { target_entity: 'member', member_id: 'member', organization_id: null,
          event_type: 'preference', payload: { field_id: 'field', new_value: 'new' } } : {}),
      });
      const state = { outbox: [row], workflowClaims: [{
        delivery_key: `dd-field-mapping:${row.id}`, tenant_id: row.tenant_id,
        entity_type: target, entity_id: target === 'member' ? row.member_id : row.organization_id,
        status: 'completed', completed_at: '2026-01-01T00:00:00Z',
      }] };
      await withFieldMappingClient(state, async () => {
        await dispatchFieldMappingWorkflowFanouts(dispatchOptions({
          triggerWorkflows: () => { throw Error('replayed'); },
          triggerPreferenceWorkflows: () => { throw Error('replayed'); },
        }));
      });
      assert.equal(row.status, 'completed');
      assert.equal(row.last_error, null);
      assert.ok(row.completed_at);
    }
  }
});

test('incomplete or mismatched claim cannot reconcile or replay stranded outbox', async () => {
  const row = fanoutRow({ status: 'processing', last_error: 'original reason' });
  for (const patch of [
    { status: 'processing' }, { status: 'failed' }, { completed_at: null },
    { tenant_id: 'other' }, { entity_type: 'member' }, { entity_id: 'other' },
    { delivery_key: 'dd-field-mapping:other' },
  ]) {
    const state = { outbox: [row], workflowClaims: [{
      delivery_key: `dd-field-mapping:${row.id}`, tenant_id: row.tenant_id,
      entity_type: 'organization', entity_id: row.organization_id,
      status: 'completed', completed_at: '2026-01-01T00:00:00Z', ...patch,
    }] };
    const original = structuredClone(row);
    await withFieldMappingClient(state, async () => {
      await assert.rejects(dispatchFieldMappingWorkflowFanouts(dispatchOptions({
        triggerWorkflows: () => { throw Error('replayed'); },
      })), (error) => assertFanoutError(error, row, 'processing'));
    });
    assert.deepEqual(row, original);
  }
});

test('durable core success and skipped workflow logs carry the claim delivery key', async () => {
  const state = {
    organization: { id: 'organization', tenant_id: 'tenant', name: 'After' },
    outbox: [fanoutRow()],
    workflows: [
      { id: 'run', tenant_id: 'tenant', name: 'run', trigger_type: 'record_update',
        trigger_mode: 'every_time', actions: [], conditions: [] },
      { id: 'skip', tenant_id: 'tenant', name: 'skip', trigger_type: 'record_update',
        trigger_mode: 'every_time', actions: [], conditions: [
          { field_id: 'name', field_type: 'core', operator: 'equals', value: 'Not After' },
        ] },
    ],
  };
  await withFieldMappingClient(state, () => dispatchFieldMappingWorkflowFanouts(dispatchOptions()));
  assert.deepEqual(state.workflowLogs.map((log) => [log.workflow_id, log.delivery_key]),
    [['run', 'dd-field-mapping:event-1'], ['skip', 'dd-field-mapping:event-1']]);
  assert.equal(state.workflowClaims[0].status, 'completed');
});

test('durable preference workflow execution log carries its own claim delivery key', async () => {
  const row = fanoutRow({ event_type: 'preference',
    payload: { field_id: 'field', new_value: 'approved', previous_value: 'pending' } });
  const state = {
    organization: { id: 'organization', tenant_id: 'tenant', name: 'After' },
    outbox: [row],
    workflows: [{ id: 'pref', tenant_id: 'tenant', name: 'pref', trigger_type: 'field_change',
      trigger_config: { field_type: 'custom', field_id: 'field', operator: 'equals', value: 'approved' },
      trigger_mode: 'every_time', actions: [], conditions: [] }],
  };
  await withFieldMappingClient(state, () => dispatchFieldMappingWorkflowFanouts(dispatchOptions()));
  assert.deepEqual(state.workflowLogs.map((log) => log.delivery_key), ['dd-field-mapping:event-1']);
  assert.equal(state.workflowClaims[0].status, 'completed');
});

test('a concurrent claim blocks dispatch without modifying or replaying the owned row', async () => {
  const row = fanoutRow();
  const state = {
    outbox: [row],
    onClaim: (candidate) => { candidate.status = 'processing'; candidate.attempt_count = 1; },
  };
  let calls = 0;
  await withFieldMappingClient(state, async () => {
    await assert.rejects(dispatchFieldMappingWorkflowFanouts(dispatchOptions({
      triggerWorkflows: async () => { calls += 1; },
    })), (error) => assertFanoutError(error, row, 'pending'));
  });
  assert.equal(row.status, 'processing');
  assert.equal(row.attempt_count, 1);
  assert.equal(row.last_error, undefined);
  assert.equal(calls, 0);
});

test('completed and foreign-tenant/submission rows are skipped; relevant rows dispatch in event-key order', async () => {
  const rows = [
    fanoutRow({ id: 'event-b', event_key: 'core:b' }),
    fanoutRow({ id: 'event-foreign-tenant', event_key: 'core:0', tenant_id: 'foreign' }),
    fanoutRow({ id: 'event-complete', event_key: 'core:1', status: 'completed' }),
    fanoutRow({ id: 'event-foreign-submission', event_key: 'core:2', form_submission_due_diligence_id: 'foreign' }),
    fanoutRow({ id: 'event-a', event_key: 'core:a' }),
  ];
  const state = { outbox: rows };
  const calls = [];
  await withFieldMappingClient(state, async () => {
    await dispatchFieldMappingWorkflowFanouts(dispatchOptions({
      triggerWorkflows: async (_entity, _id, _before, _after, _type, _url, context) => {
        calls.push(context.deliveryKey);
        return { delivery: { status: 'completed' } };
      },
    }));
  });
  assert.deepEqual(calls, ['dd-field-mapping:event-a', 'dd-field-mapping:event-b']);
  assert.deepEqual(rows.map((row) => row.status), [
    'completed', 'pending', 'completed', 'pending', 'completed',
  ]);
});

test('all dispatch failure paths include event correlation without payload diagnostics', async () => {
  for (const [name, trigger, expectedStatus, expectedFlag] of [
    ['core pre-effect query', async () => { throw new Error('load workflows for durable delivery failed: db down'); }, 'pending', 'ddKnownQueryFailure'],
    ['core ambiguous', async () => { throw new Error('provider timed out'); }, 'requires_attention', 'ddAmbiguousEffect'],
    ['core unconfirmed', async () => ({ delivery: { status: 'processing' } }), 'requires_attention', 'ddAmbiguousEffect'],
  ]) {
    const row = fanoutRow();
    await withFieldMappingClient({ outbox: [row] }, async () => {
      await assert.rejects(dispatchFieldMappingWorkflowFanouts(dispatchOptions({
        triggerWorkflows: trigger,
      })), (error) => {
        assertFanoutError(error, row, expectedStatus);
        assert.equal(error[expectedFlag], true, name);
        return true;
      });
    });
    assert.equal(row.status, expectedStatus);
  }
  const row = fanoutRow({ id: 'preference-event', event_key: 'preference:mapping:0', event_type: 'preference',
    payload: { field_id: 'field', new_value: 'secret', previous_value: null } });
  await withFieldMappingClient({ outbox: [row] }, async () => {
    await assert.rejects(dispatchFieldMappingWorkflowFanouts(dispatchOptions({
      triggerPreferenceWorkflows: async () => { throw new Error('provider timed out'); },
    })), (error) => assertFanoutError(error, row, 'requires_attention'));
  });
});

test('field mapping persists fanout before checkpoint and retry escalates an unconfirmed workflow without replay', async () => {
  const state = {
    organization: { id: 'organization', tenant_id: 'tenant', name: 'Original organization' },
    outbox: [],
  };
  const checkpoints = new Set();
  let workflowCalls = 0;
  const options = {
    completedActionKeys: checkpoints,
    onActionCompleted: async (key) => { checkpoints.add(key); },
    workflowFanoutDependencies: {
      triggerWorkflows: async () => {
        workflowCalls += 1;
        throw new Error('workflow provider connection dropped');
      },
    },
  };

  await withFieldMappingClient(state, async () => {
    await assert.rejects(
      executeFieldMappingActions('new', ddSubmission, 'tenant', 'system', options),
      { ddAmbiguousEffect: true },
    );
    assert.equal(state.organization.name, 'Renamed organization');
    assert.equal(checkpoints.has('field_mapping:mapping'), true);
    assert.equal(state.outbox[0].status, 'requires_attention');
    assert.deepEqual(state.outbox[0].payload.before.name, 'Original organization');
    assert.deepEqual(state.outbox[0].payload.after.name, 'Renamed organization');

    await assert.rejects(
      executeFieldMappingActions('new', ddSubmission, 'tenant', 'system', options),
      { ddAmbiguousEffect: true },
    );
  });
  assert.equal(workflowCalls, 1);
});

test('a completed field-mapping workflow fanout is skipped on mapping retry', async () => {
  const state = {
    organization: { id: 'organization', tenant_id: 'tenant', name: 'Original organization' },
    outbox: [],
  };
  const checkpoints = new Set();
  let workflowCalls = 0;
  const options = {
    completedActionKeys: checkpoints,
    onActionCompleted: async (key) => { checkpoints.add(key); },
    workflowFanoutDependencies: {
      triggerWorkflows: async () => {
        workflowCalls += 1;
        return { delivery: { status: 'completed' } };
      },
    },
  };

  await withFieldMappingClient(state, async () => {
    await executeFieldMappingActions('new', ddSubmission, 'tenant', 'system', options);
    assert.equal(state.outbox[0].status, 'completed');
    await executeFieldMappingActions('new', ddSubmission, 'tenant', 'system', options);
  });
  assert.equal(workflowCalls, 1);
});

test('a confirmed workflow configuration query failure leaves the fanout pending for retry', async () => {
  const state = {
    organization: { id: 'organization', tenant_id: 'tenant', name: 'Original organization' },
    outbox: [],
  };
  const checkpoints = new Set();
  let mode = 'query-failure';
  let workflowCalls = 0;
  const options = {
    completedActionKeys: checkpoints,
    onActionCompleted: async (key) => { checkpoints.add(key); },
    workflowFanoutDependencies: {
      triggerWorkflows: async () => {
        workflowCalls += 1;
        if (mode === 'query-failure') {
          throw new Error('load workflows for durable delivery failed: temporary database failure');
        }
        return { delivery: { status: 'completed' } };
      },
    },
  };

  await withFieldMappingClient(state, async () => {
    await assert.rejects(
      executeFieldMappingActions('new', ddSubmission, 'tenant', 'system', options),
      { ddKnownQueryFailure: true },
    );
    assert.equal(state.outbox[0].status, 'pending');

    mode = 'success';
    await executeFieldMappingActions('new', ddSubmission, 'tenant', 'system', options);
    assert.equal(state.outbox[0].status, 'completed');
  });
  assert.equal(workflowCalls, 2);
});

test('a confirmed preference workflow delivery completes and is not replayed', async () => {
  const state = {
    organization: { id: 'organization', tenant_id: 'tenant', name: 'Original organization' },
    preferenceFields: [{ id: 'preference', label: 'Preference' }],
    mappingAction: {
      id: 'preference-mapping',
      field_mappings: [{
        source_type: 'static',
        static_value: 'approved',
        target_type: 'custom',
        target_field: 'preference',
      }],
    },
    outbox: [],
  };
  const checkpoints = new Set();
  let workflowCalls = 0;
  const options = {
    completedActionKeys: checkpoints,
    onActionCompleted: async (key) => { checkpoints.add(key); },
    workflowFanoutDependencies: {
      triggerPreferenceWorkflows: async (_type, _id, _field, _value, _url, _previous, context) => {
        workflowCalls += 1;
        assert.match(context.deliveryKey, /^dd-field-mapping:event-1$/);
        return { delivery: { status: 'completed' } };
      },
    },
  };

  await withFieldMappingClient(state, async () => {
    await executeFieldMappingActions('new', ddSubmission, 'tenant', 'system', options);
    assert.equal(state.outbox[0].status, 'completed');
    await executeFieldMappingActions('new', ddSubmission, 'tenant', 'system', options);
  });
  assert.equal(workflowCalls, 1);
});

test('preference workflow query failure retries, while an unconfirmed preference delivery requires attention', async () => {
  const state = {
    organization: { id: 'organization', tenant_id: 'tenant', name: 'Original organization' },
    preferenceFields: [{ id: 'preference', label: 'Preference' }],
    mappingAction: {
      id: 'preference-mapping',
      field_mappings: [{
        source_type: 'static',
        static_value: 'approved',
        target_type: 'custom',
        target_field: 'preference',
      }],
    },
    outbox: [],
  };
  const checkpoints = new Set();
  let mode = 'query-failure';
  const options = {
    completedActionKeys: checkpoints,
    onActionCompleted: async (key) => { checkpoints.add(key); },
    workflowFanoutDependencies: {
      triggerPreferenceWorkflows: async () => {
        if (mode === 'query-failure') {
          throw new Error('load preference workflows for durable delivery failed: temporary database failure');
        }
        throw new Error('preference provider connection dropped');
      },
    },
  };

  await withFieldMappingClient(state, async () => {
    await assert.rejects(
      executeFieldMappingActions('new', ddSubmission, 'tenant', 'system', options),
      { ddKnownQueryFailure: true },
    );
    assert.equal(state.outbox[0].status, 'pending');

    mode = 'ambiguous';
    await assert.rejects(
      executeFieldMappingActions('new', ddSubmission, 'tenant', 'system', options),
      { ddAmbiguousEffect: true },
    );
    assert.equal(state.outbox[0].status, 'requires_attention');
  });
});

test('member workflow fanout uses the persisted member target without falling back to its organization', async () => {
  const state = {
    outbox: [{
      id: 'member-event',
      status: 'pending',
      attempt_count: 0,
      form_submission_due_diligence_id: 'dd',
      tenant_id: 'tenant',
      event_key: 'core:member-action:0',
      event_type: 'core',
      target_entity: 'member',
      organization_id: 'organization',
      member_id: 'member',
      payload: {
        before: { first_name: 'Before' },
        after: { first_name: 'After' },
      },
    }],
    organization: { id: 'organization', tenant_id: 'tenant' },
  };
  const targets = [];

  await withFieldMappingClient(state, async () => {
    await dispatchFieldMappingWorkflowFanouts({
      dueDiligenceSubmissionId: 'dd',
      tenantId: 'tenant',
      baseUrl: 'https://tenant.example',
      dependencies: {
        triggerWorkflows: async (entity, id, before, after) => {
          targets.push({ entity, id, before, after });
          return { delivery: { status: 'completed' } };
        },
      },
    });
  });

  assert.deepEqual(targets, [{
    entity: 'member',
    id: 'member',
    before: { first_name: 'Before' },
    after: { first_name: 'After' },
  }]);
  assert.equal(state.outbox[0].status, 'completed');
});

test('partial mapping retains each successful mutation fanout until a sibling write recovers', async () => {
  const state = {
    organization: {
      id: 'organization',
      tenant_id: 'tenant',
      name: 'Original organization',
      phone: 'Original phone',
    },
    failCoreField: 'phone',
    mappingAction: {
      id: 'multi-mapping',
      field_mappings: [
        {
          source_type: 'static',
          static_value: 'Renamed organization',
          target_type: 'core',
          target_field: 'name',
        },
        {
          source_type: 'static',
          static_value: '0123456789',
          target_type: 'core',
          target_field: 'phone',
        },
      ],
    },
    outbox: [],
  };
  const checkpoints = new Set();
  let workflowCalls = 0;
  const options = {
    completedActionKeys: checkpoints,
    onActionCompleted: async (key) => { checkpoints.add(key); },
    workflowFanoutDependencies: {
      triggerWorkflows: async () => {
        workflowCalls += 1;
        return { delivery: { status: 'completed' } };
      },
    },
  };

  await withFieldMappingClient(state, async () => {
    await assert.rejects(
      executeFieldMappingActions('new', ddSubmission, 'tenant', 'system', options),
      { ddKnownQueryFailure: true },
    );
    assert.equal(checkpoints.has('field_mapping:multi-mapping'), false);
    assert.equal(state.outbox.length, 1);
    assert.equal(state.outbox[0].event_key, 'core:multi-mapping:0');
    assert.equal(state.outbox[0].payload.before.name, 'Original organization');
    assert.equal(state.outbox[0].payload.after.name, 'Renamed organization');
    assert.equal(state.outbox[0].status, 'pending');

    state.failCoreField = null;
    const retry = await executeFieldMappingActions('new', ddSubmission, 'tenant', 'system', options);
    assert.equal(retry[0].status, 'success');
    assert.equal(checkpoints.has('field_mapping:multi-mapping'), true);
    assert.equal(state.outbox.length, 2);
    assert.equal(state.outbox[1].event_key, 'core:multi-mapping:1');
    assert.equal(state.outbox[1].payload.before.name, 'Renamed organization');
    assert.equal(state.outbox[1].payload.before.phone, 'Original phone');
    assert.equal(state.outbox[1].payload.after.phone, '0123456789');
  });
  assert.equal(workflowCalls, 2);
});

test('strict initialization refuses a field-mapping write when its organization snapshot fails', async () => {
  const state = {
    organization: { id: 'organization', tenant_id: 'tenant', name: 'Original organization' },
    snapshotError: { message: 'temporary organization read failure' },
    outbox: [],
  };
  let checkpoints = 0;
  await withFieldMappingClient(state, async () => {
    await assert.rejects(
      executeFieldMappingActions('new', ddSubmission, 'tenant', 'system', {
        onActionCompleted: async () => { checkpoints += 1; },
      }),
      { ddKnownQueryFailure: true },
    );
  });
  assert.equal(state.organization.name, 'Original organization');
  assert.equal(state.outbox.length, 0);
  assert.equal(checkpoints, 0);
});

test('atomic mapping RPC failure leaves neither the organization write nor outbox payload committed', async () => {
  const state = {
    organization: { id: 'organization', tenant_id: 'tenant', name: 'Original organization' },
    atomicFailure: 'outbox insert unavailable',
    outbox: [],
  };
  await withFieldMappingClient(state, async () => {
    await assert.rejects(
      executeFieldMappingActions('new', ddSubmission, 'tenant', 'system', {
        onActionCompleted: async () => {},
      }),
      { ddKnownQueryFailure: true },
    );
  });
  assert.equal(state.organization.name, 'Original organization');
  assert.equal(state.outbox.length, 0);
});

test('cross-tenant preference definition is rejected before the DD mapping can mutate it', async () => {
  const state = {
    organization: { id: 'organization', tenant_id: 'tenant', name: 'Original organization' },
    enforcePreferenceTenant: true,
    preferenceFields: [{
      id: 'foreign-preference',
      tenant_id: 'other-tenant',
      entity_scope: 'organization',
      label: 'Foreign field',
    }],
    mappingAction: {
      id: 'foreign-preference-mapping',
      field_mappings: [{
        source_type: 'static',
        static_value: 'not allowed',
        target_type: 'custom',
        target_field: 'foreign-preference',
      }],
    },
    outbox: [],
  };
  await withFieldMappingClient(state, async () => {
    const result = await executeFieldMappingActions('new', ddSubmission, 'tenant', 'system', {
      onActionCompleted: async () => {},
    });
    assert.equal(result[0].status, 'partial');
  });
  assert.equal(state.preferenceValues, undefined);
  assert.equal(state.outbox.length, 0);
});

test('ambiguous resolved sendEmail action result puts the field-mapping fanout in attention without replay', async () => {
  const state = {
    organization: { id: 'organization', tenant_id: 'tenant', name: 'Original organization' },
    workflows: [{
      id: 'email-workflow',
      name: 'Durable email',
      tenant_id: 'tenant',
      entity_type: 'organization',
      is_active: true,
      trigger_type: 'field_change',
      trigger_config: { field_id: 'name', field_type: 'core', operator: 'changed' },
      conditions: [],
      actions: [{ type: 'send_email', config: {} }],
    }],
    outbox: [],
  };
  let workflowCalls = 0;
  const options = {
    onActionCompleted: async () => {},
    workflowFanoutDependencies: {
      triggerWorkflows: async (...args) => {
        workflowCalls += 1;
        const context = args[6];
        return triggerWorkflows(...args.slice(0, 6), {
          ...context,
          // Inject the resolved provider response at the action boundary. The
          // real durable trigger then evaluates and fails its own claim.
          executeWorkflowActions: async () => [
            workflowEmailActionResult({ success: false, ambiguousEffect: true }),
          ],
        });
      },
    },
  };
  await withFieldMappingClient(state, async () => {
    await assert.rejects(
      executeFieldMappingActions('new', ddSubmission, 'tenant', 'system', options),
      { ddAmbiguousEffect: true },
    );
    assert.equal(state.outbox[0].status, 'requires_attention');
    assert.equal(state.workflowClaims[0].status, 'failed');
    await assert.rejects(
      executeFieldMappingActions('new', ddSubmission, 'tenant', 'system', options),
      { ddAmbiguousEffect: true },
    );
  });
  assert.equal(workflowCalls, 1);
  assert.equal(state.workflowClaims.length, 1);
});

test('explicit resolved sendEmail provider rejection remains a known retryable fanout failure', async () => {
  const state = {
    organization: { id: 'organization', tenant_id: 'tenant', name: 'Original organization' },
    outbox: [],
  };
  let workflowCalls = 0;
  let providerRejected = true;
  const options = {
    onActionCompleted: async () => {},
    workflowFanoutDependencies: {
      triggerWorkflows: async () => {
        workflowCalls += 1;
        const outcome = durableDeliveryOutcomeError([
          workflowEmailActionResult(providerRejected
            ? { success: false, error: 'recipient rejected' }
            : { success: true }),
        ]);
        if (outcome.error) throw outcome.error;
        return { delivery: { status: 'completed' } };
      },
    },
  };
  await withFieldMappingClient(state, async () => {
    await assert.rejects(
      executeFieldMappingActions('new', ddSubmission, 'tenant', 'system', options),
      { ddKnownQueryFailure: true },
    );
    assert.equal(state.outbox[0].status, 'pending');
    providerRejected = false;
    await executeFieldMappingActions('new', ddSubmission, 'tenant', 'system', options);
    assert.equal(state.outbox[0].status, 'completed');
  });
  assert.equal(workflowCalls, 2);
});