import { processAttendanceResultTransition } from './workflows.js';

async function requireRpc(db, name, args) {
  const { data, error } = await db.rpc(name, args);
  if (error) throw new Error(`${name} failed: ${error.message}`);
  return data;
}

export async function publishAttendanceTransition(row, baseUrl) {
  const payload = row?.payload;
  if (!payload?.booking?.type || !payload?.booking?.id || !row.tenant_id || !payload?.transitionId) {
    throw new Error('Attendance transition payload is incomplete');
  }
  // Non-final facts remain available in the durable transition stream, but do
  // not satisfy the workflow engine's final attendance-result trigger.
  if (!['attended', 'below_threshold', 'absent'].includes(payload.status)) {
    return { skipped: true, reason: 'non_final_attendance_result' };
  }
  const result = await processAttendanceResultTransition({
    ...payload,
    tenant_id: row.tenant_id,
    transition_id: row.transition_id,
  }, baseUrl);
  if (result?.delivery?.status !== 'completed') {
    const blocked = result?.delivery?.blocked || [];
    const workflowIds = blocked.map(item => item.workflow_id).filter(Boolean).join(',');
    throw new Error(
      `Attendance workflow delivery is ${result?.delivery?.status || 'unconfirmed'}`
      + (workflowIds ? ` for workflow(s) ${workflowIds}` : ''),
    );
  }
  return result;
}

export async function processAttendanceTransitionOutbox(db, {
  limit = 25,
  baseUrl,
  publish = publishAttendanceTransition,
  maxAttempts = 8,
} = {}) {
  const claimed = await requireRpc(db, 'claim_attendance_transition_outbox', {
    p_limit: Math.min(100, Math.max(1, Number(limit) || 25)),
  });
  const result = { claimed: claimed?.length || 0, published: 0, failed: 0 };
  for (const row of claimed || []) {
    try {
      const publication = await publish(row, baseUrl);
      if (publication?.delivery && publication.delivery.status !== 'completed') {
        throw new Error(`Attendance workflow delivery is ${publication.delivery.status}`);
      }
      const completed = await requireRpc(db, 'complete_attendance_transition_outbox', {
        p_id: row.id,
        p_lock_token: row.lock_token,
      });
      if (!completed) throw new Error('Attendance transition claim expired before completion');
      result.published += 1;
    } catch (error) {
      result.failed += 1;
      await requireRpc(db, 'fail_attendance_transition_outbox', {
        p_id: row.id,
        p_lock_token: row.lock_token,
        p_error: error?.message || String(error),
        p_max_attempts: maxAttempts,
      });
    }
  }
  return result;
}