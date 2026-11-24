import { AsyncLocalStorage } from 'node:async_hooks';

// Opt-in bootstrap: deploy only after the separate control schema is approved.
// Once enabled, missing schema, transport failures and malformed responses fail closed.
const operations = new AsyncLocalStorage();

export function speakerRolloutError(code = 'SPEAKER_ROLLOUT_UNAVAILABLE') {
  const error = new Error(code === 'SPEAKER_ROLLOUT_PAUSED'
    ? 'Speaker processing is temporarily paused for maintenance.'
    : 'Speaker rollout controls are unavailable. Please retry later.');
  error.code = code;
  error.status = 503;
  return error;
}

export async function withSpeakerRolloutOperation(db, kind, work, {
  enabled = process.env.SPEAKER_ROLLOUT_CONTROL_ENABLED === 'true',
  deployment = process.env.VERCEL_DEPLOYMENT_ID || process.env.VERCEL_URL || 'local',
  revision = process.env.VERCEL_GIT_COMMIT_SHA || 'unknown',
} = {}) {
  const parent = operations.getStore();
  if (parent?.db === db && parent.active) return work();
  if (!enabled) return work();
  let admission;
  try {
    admission = await db.rpc('begin_speaker_rollout_operation', {
      p_kind: kind, p_deployment: deployment, p_revision: revision,
    });
  } catch {
    throw speakerRolloutError();
  }
  if (admission.error) {
    throw speakerRolloutError(admission.error.code === 'PT503'
      ? 'SPEAKER_ROLLOUT_PAUSED' : undefined);
  }
  if (typeof admission.data !== 'string'
      || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(admission.data)) {
    throw speakerRolloutError();
  }
  const context = { db, active: true };
  let failed = false;
  try {
    return await operations.run(context, work);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    context.active = false;
    // Never expire or delete an unfinished operation. If this final write fails,
    // the durable row deliberately blocks pause until an operator investigates.
    try {
      const result = await db.rpc('finish_speaker_rollout_operation', {
        p_id: admission.data, p_failed: failed,
      });
      if (result.error || result.data !== true) throw speakerRolloutError();
    } catch {
      console.error('[Speaker rollout] Operation completion could not be recorded', admission.data);
      if (!failed) throw speakerRolloutError();
    }
  }
}
