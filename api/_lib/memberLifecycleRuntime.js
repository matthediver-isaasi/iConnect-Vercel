import { randomUUID } from 'node:crypto';
import { validateLifecyclePolicy, evaluateMemberLifecycle } from '../../shared/memberLifecyclePolicy.mjs';
import { lifecycleRows, loadMemberLifecycleEvidence } from './memberLifecycleEvidence.js';
import { loadLifecycleMember } from './memberLifecycleReview.js';
import { executeLifecycleTransition } from './memberLifecycleExecution.js';
import { lifecycleStableDetail } from './memberLifecycleSnapshot.js';
import { queueLifecycleNotice } from './memberLifecycleNotifications.js';

export async function lifecycleRuntimeReady(db) {
  const { data, error } = await db.rpc('member_lifecycle_runtime_ready');
  if (error && ['PGRST202', '42883'].includes(error.code)) return false;
  if (error) throw error;
  return data === true;
}

async function rpc(db, name, args) {
  const { data, error } = await db.rpc(name, args);
  if (error) throw error;
  return data;
}

export async function runtimeLifecyclePreview(db, tenantId, actor, saved, body, deps = {}) {
  let preview;
  if (!body.previewId) preview = await rpc(db, 'member_lifecycle_preview_start', {
    p_tenant_id: tenantId, p_actor: actor, p_revision: saved.revision,
  });
  else {
    const result = await db.from('member_lifecycle_preview').select('*')
      .eq('tenant_id', tenantId).eq('id', body.previewId).eq('created_by', actor).maybeSingle();
    if (result.error) throw result.error;
    preview = result.data;
  }
  if (!preview || preview.policy_revision !== saved.revision || preview.complete
    || preview.cursor !== (body.cursor || null) || new Date(preview.expires_at) <= new Date()) {
    throw Object.assign(new Error('Preview expired or changed; start again'), { status: 409 });
  }
  let query = db.from('member_lifecycle_preview_roster').select('member_id').eq('preview_id', preview.id).order('member_id').limit(10);
  if (body.cursor) query = query.gt('member_id', body.cursor);
  const { data: roster, error } = await query;
  if (error || !Array.isArray(roster)) throw error || new Error('Preview population unavailable');
  const policy = validateLifecyclePolicy(saved.policy);
  const roles = await (deps.readRows || lifecycleRows)(db, 'role', tenantId);
  const items = [];
  for (const row of roster) {
    const { member } = await loadLifecycleMember(db, tenantId, row.member_id);
    const evidence = await (deps.loadEvidence || loadMemberLifecycleEvidence)(db, tenantId, member, policy, new Date(), { expiryCoordinated: true });
    items.push({ memberId: member.id, ...evaluateMemberLifecycle({ tenantId, member, evidence, policy, roles }),
      unavailableSources: evidence.unavailableSources || [] });
  }
  const result = await rpc(db, 'member_lifecycle_runtime_preview_page', {
    p_tenant_id: tenantId, p_actor: actor, p_revision: saved.revision, p_preview_id: preview.id,
    p_cursor: body.cursor || null, p_items: items,
  });
  return { ...result, items, executionReady: true, readinessIssues: [] };
}

// One bounded tenant chunk per invocation. Database ordering and next_run_at
// ensure large tenants resume without starving later tenants.
export async function processLifecycleChunk(db, { now = () => Date.now(), budgetMs = 20000, detail = lifecycleStableDetail,
  execute = executeLifecycleTransition, queueNotice = queueLifecycleNotice } = {}) {
  const token = randomUUID();
  const lease = await rpc(db, 'member_lifecycle_claim', { p_token: token });
  if (!lease) return { processed: 0 };
  const start = now();
  let cursor = lease.cursor || null, processed = 0, done = false;
  try {
    const { data: saved, error } = await db.from('member_lifecycle_policy').select('policy,revision,enabled')
      .eq('tenant_id', lease.tenant_id).single();
    if (error) throw error;
    if (!saved.enabled || saved.revision !== lease.approved_revision) throw new Error('Policy paused or changed');
    saved.policy = validateLifecyclePolicy(saved.policy);
    const ids = await rpc(db, 'member_lifecycle_population', { p_tenant_id: lease.tenant_id, p_cursor: cursor });
    if (!Array.isArray(ids)) throw new Error('Member population unavailable');
    for (const memberId of ids.slice(0, 10)) {
      if (now() - start >= budgetMs) break;
      const current = await detail(db, lease.tenant_id, memberId, saved.policy);
      if (current.proposal.action !== 'none') {
        await execute(db, {
          tenantId: lease.tenant_id, actor: 'system:member-lifecycle', saved, automatic: true, leaseToken: token,
          body: { action: current.proposal.action, memberId, expectedRevision: current.revision, reason: current.proposal.reason },
        }, { detail: async () => current });
      } else {
        // Actual transition notices use the durable operation outbox. Upcoming
        // dates can be retried before advancing this member cursor.
        await queueNotice(db,{tenantId:lease.tenant_id,memberId,proposal:current.proposal,saved});
      }
      cursor = memberId; processed++;
    }
    done = ids.length <= 10 && processed === ids.length;
    await rpc(db, 'member_lifecycle_checkpoint', { p_tenant_id: lease.tenant_id, p_token: token,
      p_cursor: cursor, p_done: done, p_error: null });
    return { tenantId: lease.tenant_id, processed, done };
  } catch (error) {
    await rpc(db, 'member_lifecycle_checkpoint', { p_tenant_id: lease.tenant_id, p_token: token,
      p_cursor: cursor, p_done: false, p_error: error.code === 'PT409' || error.status === 409
        ? 'Source conflict; retained for retry' : 'Processing failed; retained for retry' });
    throw error;
  }
}
