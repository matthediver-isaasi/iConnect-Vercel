import { supabase } from '../_lib/database.js';
import { triggerWorkflows, triggerPreferenceWorkflows } from '../_lib/workflows.js';

const OUTBOX_TABLE = 'form_due_diligence_field_mapping_workflow_outbox';

function knownQueryFailure(context, cause) {
  const error = new Error(`${context}: ${cause?.message || 'database error'}`);
  error.ddKnownQueryFailure = true;
  return error;
}

function ambiguousFanoutFailure(context, cause) {
  const error = new Error(`${context}: ${cause?.message || 'workflow delivery is not confirmed'}`);
  error.ddAmbiguousEffect = true;
  return error;
}

/**
 * Persist a field-mapping workflow event before its mapping action is marked
 * complete.  The action checkpoint can consequently never hide an unfanned-out
 * change on a later initialization retry.
 */
export async function enqueueFieldMappingWorkflowFanout({
  dueDiligenceSubmissionId,
  tenantId,
  eventKey,
  eventType,
  organizationId,
  payload,
}) {
  const { error } = await supabase
    .from(OUTBOX_TABLE)
    .upsert({
      form_submission_due_diligence_id: dueDiligenceSubmissionId,
      tenant_id: tenantId,
      event_key: eventKey,
      event_type: eventType,
      organization_id: organizationId,
      payload,
    }, {
      onConflict: 'form_submission_due_diligence_id,event_key',
      ignoreDuplicates: true,
    });
  if (error) {
    // Mapping data has already been written. Without this payload there is no
    // safe way to reconstruct the old value, so this is not retry-safe.
    throw ambiguousFanoutFailure('Could not persist field-mapping workflow fanout', error);
  }
}

// The initializer opts into this RPC so a DD mapping write and the payload
// needed to recover its workflow fanout commit (or roll back) together.
export async function applyFieldMappingMutationWithFanout({
  tenantId,
  dueDiligenceSubmissionId,
  eventKey,
  eventType,
  organizationId,
  mutation,
  preferenceFieldId = null,
  preferenceValue = null,
}) {
  const { data, error } = await supabase.rpc(
    'apply_form_due_diligence_field_mapping_with_outbox',
    {
      p_tenant_id: tenantId,
      p_due_diligence_submission_id: dueDiligenceSubmissionId,
      p_event_key: eventKey,
      p_event_type: eventType,
      p_organization_id: organizationId,
      p_mutation: mutation || {},
      p_preference_field_id: preferenceFieldId,
      p_preference_value: preferenceValue,
    },
  );
  if (error) {
    // The RPC is one database transaction: its error confirms neither the
    // mapping mutation nor its fanout was committed, so initialization retries.
    throw knownQueryFailure('Could not atomically persist field mapping and workflow fanout', error);
  }
  if (!data || typeof data !== 'object') {
    throw knownQueryFailure(
      'Could not atomically persist field mapping and workflow fanout',
      { message: 'invalid RPC result' },
    );
  }
  return data;
}

async function loadPendingFanouts(dueDiligenceSubmissionId, tenantId) {
  const { data, error } = await supabase
    .from(OUTBOX_TABLE)
    .select('*')
    .eq('form_submission_due_diligence_id', dueDiligenceSubmissionId)
    .eq('tenant_id', tenantId)
    .in('status', ['pending', 'processing', 'requires_attention']);
  if (error) throw knownQueryFailure('Could not read field-mapping workflow fanout', error);
  return data || [];
}

async function markFanout(event, status, error = null) {
  const { error: updateError } = await supabase
    .from(OUTBOX_TABLE)
    .update({
      status,
      ...(status === 'completed' ? { completed_at: new Date().toISOString() } : {}),
      ...(error ? { last_error: String(error.message || error).slice(0, 2000) } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq('id', event.id);
  if (updateError) {
    throw ambiguousFanoutFailure('Could not record field-mapping workflow fanout state', updateError);
  }
}

async function claimFanout(event) {
  const { data, error } = await supabase
    .from(OUTBOX_TABLE)
    .update({
      status: 'processing',
      attempt_count: (event.attempt_count || 0) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('id', event.id)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();
  if (error) throw knownQueryFailure('Could not claim field-mapping workflow fanout', error);
  return Boolean(data);
}

async function dispatchPreferenceFanout(event, baseUrl, dependencies) {
  const deliveryKey = `dd-field-mapping:${event.id}`;
  try {
    const outcome = await dependencies.triggerPreferenceWorkflows(
      'organization',
      event.organization_id,
      event.payload.field_id,
      event.payload.new_value,
      baseUrl,
      event.payload.previous_value,
      { deliveryKey },
    );
    if (outcome?.delivery?.status === 'completed') {
      await markFanout(event, 'completed');
      return;
    }
    const unknown = ambiguousFanoutFailure('Preference workflow delivery is not confirmed');
    await markFanout(event, 'requires_attention', unknown);
    throw unknown;
  } catch (error) {
    // The optional delivery mode makes these query errors explicit before a
    // workflow delivery claim/action begins, so they are safe to retry.
    if (
      error?.message?.startsWith('load preference workflow entity for durable delivery failed:')
      || error?.message?.startsWith('load preference workflows for durable delivery failed:')
    ) {
      await markFanout(event, 'pending', error);
      throw knownQueryFailure('Could not load preference workflows for durable delivery', error);
    }
    if (error?.ddKnownQueryFailure) {
      await markFanout(event, 'pending', error);
      throw error;
    }
    await markFanout(event, 'requires_attention', error);
    throw ambiguousFanoutFailure('Preference workflow delivery is unconfirmed', error);
  }
}

async function dispatchCoreFanout(event, baseUrl, dependencies) {
  const deliveryKey = `dd-field-mapping:${event.id}`;
  try {
    const outcome = await dependencies.triggerWorkflows(
      'organization',
      event.organization_id,
      event.payload.before,
      event.payload.after,
      'field_change',
      baseUrl,
      { deliveryKey },
    );
    if (outcome?.delivery?.status === 'completed') {
      await markFanout(event, 'completed');
      return;
    }
    const unknown = ambiguousFanoutFailure('Organization workflow delivery is not confirmed');
    await markFanout(event, 'requires_attention', unknown);
    throw unknown;
  } catch (error) {
    // triggerWorkflows throws this specific error before it claims the
    // delivery, so it is a confirmed pre-effect query failure and can retry.
    if (error?.message?.startsWith('load workflows for durable delivery failed:')) {
      await markFanout(event, 'pending', error);
      throw knownQueryFailure('Could not load organization workflows for durable delivery', error);
    }
    if (error?.ddKnownQueryFailure) {
      await markFanout(event, 'pending', error);
      throw error;
    }
    await markFanout(event, 'requires_attention', error);
    throw ambiguousFanoutFailure('Organization workflow delivery is unconfirmed', error);
  }
}

/**
 * Deliver every persisted event not already completed. A completed event is
 * never invoked again. A surviving processing event represents a worker that
 * died after dispatch began and is deliberately escalated instead of replayed.
 */
export async function dispatchFieldMappingWorkflowFanouts({
  dueDiligenceSubmissionId,
  tenantId,
  baseUrl,
  dependencies = {},
}) {
  const events = await loadPendingFanouts(dueDiligenceSubmissionId, tenantId);
  const runners = {
    triggerWorkflows: dependencies.triggerWorkflows || triggerWorkflows,
    triggerPreferenceWorkflows: dependencies.triggerPreferenceWorkflows || triggerPreferenceWorkflows,
  };

  for (const event of events) {
    if (event.status === 'requires_attention') {
      throw ambiguousFanoutFailure(
        'A field-mapping workflow delivery requires attention and will not be replayed',
      );
    }
    if (event.status === 'processing') {
      const unknown = ambiguousFanoutFailure(
        'A prior field-mapping workflow delivery was interrupted and requires attention',
      );
      await markFanout(event, 'requires_attention', unknown);
      throw unknown;
    }
    if (!(await claimFanout(event))) {
      // A concurrent worker owns it. It may have crossed an external boundary;
      // treating that as complete or replaying it would both be unsafe. Do not
      // overwrite the owner's processing row while it may still be active.
      throw ambiguousFanoutFailure(
        'Field-mapping workflow delivery ownership changed and requires attention',
      );
    }
    if (event.event_type === 'core') {
      await dispatchCoreFanout(event, baseUrl, runners);
    } else {
      await dispatchPreferenceFanout(event, baseUrl, runners);
    }
  }
}

export const __testables = {
  knownQueryFailure,
  ambiguousFanoutFailure,
};