const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function handleManualCardApproval(req, res, { db, context, checkAdmin }) {
  if (!(await checkAdmin(context))) return res.status(403).json({ error: 'Administrator access required' });
  const { memberId, historyId, action } = req.body || {};
  if (action !== 'approve_card_membership' || !uuid.test(memberId || '') || !uuid.test(historyId || '')) {
    return res.status(400).json({ error: 'A valid member and membership record are required' });
  }
  const { data, error } = await db.rpc('approve_manual_card_membership_activation', {
    p_tenant_id: context.tenantId, p_member_id: memberId, p_history_id: historyId,
    p_actor_email: context.email || context.userEmail
      || (context.tenantUserId ? `tenant-user:${context.tenantUserId}` : `member:${context.memberId}`),
  });
  if (error) {
    console.error('[Manual card approval] Database operation failed:', error.code);
    return res.status(500).json({ error: 'Membership approval failed. No approval was committed; please retry.' });
  }
  if (!data?.ok) return res.status(409).json({ error: data?.detail || 'Membership cannot be approved' });
  return res.json(data);
}
