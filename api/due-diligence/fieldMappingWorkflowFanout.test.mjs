import test from 'node:test';
import assert from 'node:assert/strict';
import { supabase } from '../_lib/database.js';
import { executeFieldMappingActions } from './_stageActions.js';
import {
  durableDeliveryOutcomeError,
  triggerWorkflows,
  workflowEmailActionResult,
} from '../_lib/workflows.js';

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
            submission_data: {},
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
        if (table === 'form') return { data: { fields: [] }, error: null };
        if (table === 'workflow') return { data: state.workflows || [], error: null };
        if (table === 'workflow_log') return { data: null, error: null };
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
            data: state.workflowClaims.find((row) => row.delivery_key === filters.delivery_key) || null,
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
        if (table === 'form_submission_due_diligence') return { data: { history_log: [] }, error: null };
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
            const row = state.outbox.find((item) => item.id === filters.id);
            if (!row || (filters.status && row.status !== filters.status)) {
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