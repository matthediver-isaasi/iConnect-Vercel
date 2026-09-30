import { supabase } from '../_lib/database.js';
import { triggerWorkflows, triggerPreferenceWorkflows } from '../_lib/workflows.js';

const OUTBOX_TABLE = 'form_due_diligence_field_mapping_workflow_outbox';

function targetLabel(targetEntity) {
  return targetEntity === 'member' ? 'Member' : 'Organization';
}

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

function attachFanoutDiagnostics(error, event) {
  // Keep the persisted payload out of diagnostics. The original last_error is
  // only attached as a separate server-side property, never in the message.
  // Only member mapping keys include an occurrence; legacy organization keys
  // are deliberately left intact, without guessing an occurrence from them.
  const occurrence = /^(?:core|preference):member:([^:]+):[^:]+:\d+$/
    .exec(event.event_key || '')?.[1];
  error.ddFanout = {
    event_id: event.id,
    event_key: event.event_key,
    delivery_key: `dd-field-mapping:${event.id}`,
    status: event.status,
    ...(occurrence ? { stage_action_occurrence_id: occurrence } : {}),
  };
  if (event.status === 'requires_attention' && event.last_error) {
    error.ddFanoutRecordedReason = event.last_error;
  }
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
  targetEntity = 'organization',
  organizationId = null,
  memberId = null,
  payload,
}) {
  if (!['organization', 'member'].includes(targetEntity)) {
    throw new Error(`Invalid field-mapping workflow target entity: ${targetEntity}`);
  }
  const targetId = targetEntity === 'member' ? memberId : organizationId;
  if (!targetId) {
    throw new Error(`Missing ${targetEntity} target for field-mapping workflow fanout`);
  }
  const { error } = await supabase
    .from(OUTBOX_TABLE)
    .upsert({
      form_submission_due_diligence_id: dueDiligenceSubmissionId,
      tenant_id: tenantId,
      event_key: eventKey,
      event_type: eventType,
      target_entity: targetEntity,
      organization_id: organizationId,
      member_id: memberId,
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
  targetEntity = 'organization',
  organizationId = null,
  memberId = null,
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
      p_target_entity: targetEntity,
      p_member_id: memberId,
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
    .eq('id', event.id)
    .eq('tenant_id', event.tenant_id)
    .eq('form_submission_due_diligence_id', event.form_submission_due_diligence_id);
  if (updateError) {
    throw ambiguousFanoutFailure('Could not record field-mapping workflow fanout state', updateError);
  }
  event.status = status;
  if (error) event.last_error = String(error.message || error).slice(0, 2000);
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
    .eq('tenant_id', event.tenant_id)
    .eq('form_submission_due_diligence_id', event.form_submission_due_diligence_id)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();
  if (error) throw knownQueryFailure('Could not claim field-mapping workflow fanout', error);
  if (data) event.status = 'processing';
  return Boolean(data);
}

// A completed durable claim is the only evidence that the trigger finished
// its whole action batch. Individual successful action logs are not proof.
async function reconcileCompletedFanout(event) {
  const targetEntity = event.target_entity || 'organization';
  const targetId = targetEntity === 'member' ? event.member_id : event.organization_id;
  if (!event.id || !event.event_key || !event.tenant_id || !targetId) return false;
  const { data: claim, error } = await supabase
    .from('workflow_delivery_claim')
    .select('delivery_key,tenant_id,entity_type,entity_id,status,completed_at')
    .eq('delivery_key', `dd-field-mapping:${event.id}`)
    .eq('tenant_id', event.tenant_id)
    .eq('entity_type', targetEntity)
    .eq('entity_id', targetId)
    .eq('status', 'completed')
    .maybeSingle();
  if (error) throw knownQueryFailure('Could not verify completed field-mapping workflow delivery', error);
  if (!claim || claim.delivery_key !== `dd-field-mapping:${event.id}`
    || claim.tenant_id !== event.tenant_id || claim.entity_type !== targetEntity
    || claim.entity_id !== targetId || claim.status !== 'completed' || !claim.completed_at) return false;
  const { data, error: updateError } = await supabase
    .from(OUTBOX_TABLE)
    .update({ status: 'completed', completed_at: new Date().toISOString(), last_error: null, updated_at: new Date().toISOString() })
    .eq('id', event.id)
    .eq('event_key', event.event_key)
    .eq('tenant_id', event.tenant_id)
    .eq('form_submission_due_diligence_id', event.form_submission_due_diligence_id)
    .eq('target_entity', targetEntity)
    .eq(targetEntity === 'member' ? 'member_id' : 'organization_id', targetId)
    .in('status', ['processing', 'requires_attention'])
    .select('id')
    .maybeSingle();
  if (updateError) throw ambiguousFanoutFailure('Could not reconcile completed field-mapping workflow delivery', updateError);
  if (!data) throw ambiguousFanoutFailure('Field-mapping workflow outbox changed during reconciliation');
  event.status = 'completed';
  return true;
}

async function dispatchPreferenceFanout(event, baseUrl, dependencies) {
  const deliveryKey = `dd-field-mapping:${event.id}`;
  const targetEntity = event.target_entity || 'organization';
  const targetId = targetEntity === 'member' ? event.member_id : event.organization_id;
  if (!targetId) {
    throw ambiguousFanoutFailure(
      `Field-mapping ${targetEntity} workflow fanout has no persisted target`,
    );
  }
  try {
    const outcome = await dependencies.triggerPreferenceWorkflows(
      targetEntity,
      targetId,
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
    const unknown = ambiguousFanoutFailure(
      `${targetEntity === 'member' ? 'Member preference' : 'Preference'} workflow delivery is not confirmed`,
    );
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
    throw ambiguousFanoutFailure(
      `${targetEntity === 'member' ? 'Member preference' : 'Preference'} workflow delivery is unconfirmed`,
      error,
    );
  }
}

async function dispatchCoreFanout(event, baseUrl, dependencies) {
  const deliveryKey = `dd-field-mapping:${event.id}`;
  const targetEntity = event.target_entity || 'organization';
  const targetId = targetEntity === 'member' ? event.member_id : event.organization_id;
  if (!targetId) {
    throw ambiguousFanoutFailure(
      `Field-mapping ${targetEntity} workflow fanout has no persisted target`,
    );
  }
  try {
    const outcome = await dependencies.triggerWorkflows(
      targetEntity,
      targetId,
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
    const unknown = ambiguousFanoutFailure(
      `${targetLabel(targetEntity)} workflow delivery is not confirmed`,
    );
    throw unknown;
  } catch (error) {
    // triggerWorkflows throws this specific error before it claims the
    // delivery, so it is a confirmed pre-effect query failure and can retry.
    if (error?.message?.startsWith('load workflows for durable delivery failed:')) {
      await markFanout(event, 'pending', error);
      throw knownQueryFailure(
        `Could not load ${targetLabel(targetEntity).toLowerCase()} workflows for durable delivery`,
        error,
      );
    }
    if (error?.ddKnownQueryFailure) {
      await markFanout(event, 'pending', error);
      throw error;
    }
    await markFanout(event, 'requires_attention', error);
    throw ambiguousFanoutFailure(
      `${targetLabel(targetEntity)} workflow delivery is unconfirmed`,
      error,
    );
  }
}

/**
 * Deliver pending events only. A completed event is never invoked again.
 * Processing may be owned by a live worker or interrupted; neither case can
 * safely be reclaimed or replayed by this dispatcher.
 */
export async function dispatchFieldMappingWorkflowFanouts({
  dueDiligenceSubmissionId,
  tenantId,
  baseUrl,
  dependencies = {},
}) {
  const events = (await loadPendingFanouts(dueDiligenceSubmissionId, tenantId))
    .sort((a, b) => (
      String(a.event_key).localeCompare(String(b.event_key), 'en')
      || String(a.id).localeCompare(String(b.id), 'en')
    ));
  const runners = {
    triggerWorkflows: dependencies.triggerWorkflows || triggerWorkflows,
    triggerPreferenceWorkflows: dependencies.triggerPreferenceWorkflows || triggerPreferenceWorkflows,
  };

  for (const event of events) {
    try {
      if (['processing', 'requires_attention'].includes(event.status)
        && await reconcileCompletedFanout(event)) continue;
      if (event.status === 'requires_attention') {
        throw ambiguousFanoutFailure(
          'A field-mapping workflow delivery requires attention and will not be replayed',
        );
      }
      if (event.status === 'processing') {
        throw ambiguousFanoutFailure(
          'A field-mapping workflow delivery is processing or interrupted and will not be replayed',
        );
      }
      if (!(await claimFanout(event))) {
        // Another worker may own it; do not overwrite or replay its work.
        throw ambiguousFanoutFailure(
          'Field-mapping workflow delivery ownership changed and requires attention',
        );
      }
      if (event.event_type === 'core') {
        await dispatchCoreFanout(event, baseUrl, runners);
      } else {
        await dispatchPreferenceFanout(event, baseUrl, runners);
      }
    } catch (error) {
      throw attachFanoutDiagnostics(error, event);
    }
  }
}

export const __testables = {
  knownQueryFailure,
  ambiguousFanoutFailure,
};