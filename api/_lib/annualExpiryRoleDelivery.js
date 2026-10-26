// Only atomic role transitions produce these events. A pending action or a
// member already holding the fallback role is never transition evidence.
export async function deliverAnnualExpiryRoleEvents(db, { tenantId, results, owner, guard = () => {} }, { dispatch, baseUrl }) {
  let after = null;
  let unresolvedRoleEvents = 0;
  while (true) {
    guard();
    let query = db.from('membership_expiry_action').select('*').eq('tenant_id', tenantId)
      .in('role_event_state', ['pending', 'review']).order('id').limit(100);
    if (after) query = query.gt('id', after);
    if (owner?.member_id) query = query.eq('member_id', owner.member_id);
    // Owner simulations use recording effects, never this live capability.
    const { data: rows, error } = await query;
    if (error) throw new Error(`Load expiry workflow events: ${error.message}`);
    if (!rows?.length) return { unresolvedRoleEvents };
    for (const event of rows) {
      guard();
      const key = `annual-expiry-role:${tenantId}:${event.id}`;
      const claim = await db.from('workflow_delivery_claim').select('status')
        .eq('tenant_id', tenantId).eq('delivery_key', key).maybeSingle();
      if (claim.error) throw new Error(`Read expiry workflow delivery: ${claim.error.message}`);
      let state = event.role_event_state, reason = event.role_event_error;
      if (claim.data?.status === 'completed') state = 'completed';
      else if (claim.data || state === 'review') {
        state = 'review';
        reason ||= 'Workflow delivery is uncertain; reconcile effects before retrying.';
      } else {
        const before = event.role_event_before, updated = event.role_event_after;
        if (!before || !updated || before.tenant_id !== tenantId || updated.tenant_id !== tenantId
            || before.id !== event.member_id || updated.id !== event.member_id
            || before.role_id === updated.role_id) throw new Error('Invalid expiry transition evidence');
        try {
          const outcome = await dispatch('member', event.member_id, before, updated, 'field_change',
            await baseUrl(tenantId), { systemInitiated: true, deliveryKey: key });
          if (outcome?.delivery?.status === 'completed') state = 'completed';
          else { state = 'review'; reason = 'Workflow delivery did not confirm completion.'; }
        } catch (error) {
          // A dispatcher claim is written before any actions. Its absence
          // proves either pre-dispatch failure or a confirmed safe release.
          const check = await db.from('workflow_delivery_claim').select('status')
            .eq('tenant_id', tenantId).eq('delivery_key', key).maybeSingle();
          if (check.error) throw new Error(`Inspect expiry workflow failure: ${check.error.message}`);
          state = check.data?.status === 'completed' ? 'completed' : check.data ? 'review' : 'pending';
          reason = 'Workflow dispatch failed; inspect the durable workflow delivery outcome.';
        }
      }
      const saved = await db.from('membership_expiry_action').update({
        role_event_state: state, role_event_error: state === 'completed' ? null : reason,
      }).eq('tenant_id', tenantId).eq('id', event.id);
      if (saved.error) throw new Error(`Persist expiry workflow outcome: ${saved.error.message}`);
      if (state !== 'completed') unresolvedRoleEvents++;
      if (state !== 'completed' && results) {
        results.errors = (results.errors || 0) + 1;
        results.isolatedErrors = (results.isolatedErrors || 0) + 1;
        results.details?.push({ tenantId, memberId: event.member_id, expiryActionId: event.id,
          stage: 'annual-expiry', status: state === 'review' ? 'review_required' : 'retry_pending', reason });
      }
    }
    after = rows.at(-1).id;
  }
}
