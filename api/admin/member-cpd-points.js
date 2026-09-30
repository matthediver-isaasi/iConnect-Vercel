import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess, hasFeatureAccess } from '../_lib/tenantContext.js';

const FEATURE_ID = 'cpd.points-corrections';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SIGNED_POINTS = /^-?(?:0|[1-9]\d{0,13})(?:\.\d{1,6})?$/;

async function authorize(req, res, deps) {
  const context = await deps.getTenantContext(req);
  if (!context?.tenantId || !context.isAuthenticated) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  const allowed = Boolean(context.tenantUserId) || Boolean(
    context.roleId
    && await deps.hasAdminAccess(context)
    && await deps.hasFeatureAccess(context.roleId, FEATURE_ID, context.memberExcludedFeatures),
  );
  if (!allowed) {
    res.status(403).json({ error: 'CPD points correction permission is required' });
    return null;
  }
  return context;
}

function publicEntry(row) {
  return {
    ...row,
    points_value: String(row.points_value),
    evidence_snapshot: undefined,
    rule_snapshot: undefined,
    source_metadata: undefined,
    row_hash: undefined,
  };
}

export function createMemberCpdPointsHandler(overrides = {}) {
  const deps = {
    db: supabase,
    getTenantContext,
    hasAdminAccess,
    hasFeatureAccess,
    ...overrides,
  };
  return async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!deps.db) return res.status(503).json({ error: 'Database not configured' });
  const context = await authorize(req, res, deps);
  if (!context) return;

  const memberId = String(req.method === 'GET' ? req.query?.member_id : req.body?.member_id || '');
  if (!UUID.test(memberId)) return res.status(400).json({ error: 'A valid member_id is required' });

  const { data: member, error: memberError } = await deps.db.from('member').select('id')
    .eq('id', memberId).eq('tenant_id', context.tenantId).maybeSingle();
  if (memberError) return res.status(500).json({ error: 'Failed to validate CPD member' });
  if (!member) return res.status(404).json({ error: 'Member not found' });

  if (req.method === 'GET') {
    const { data, error } = await deps.db.from('member_cpd_points_ledger')
      .select('id,entry_kind,points_value,event_type,event_id,activity_date,activity_title,ticket_name_snapshot,award_trigger,reversal_of,correction_of,reason,created_by,created_at')
      .eq('tenant_id', context.tenantId).eq('member_id', memberId)
      .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(200);
    if (error) return res.status(500).json({ error: 'Failed to load CPD points history' });
    return res.status(200).json({ entries: (data || []).map(publicEntry) });
  }

  const action = String(req.body?.action || '');
  const ledgerEntryId = String(req.body?.ledger_entry_id || '');
  const reason = String(req.body?.reason || '').trim();
  const rawPoints = String(req.body?.points_value ?? '');
  const correctionKey = String(req.body?.correction_key || '');
  if (!['reverse', 'adjust'].includes(action) || !UUID.test(ledgerEntryId)) {
    return res.status(400).json({ error: 'A valid correction action and ledger entry are required' });
  }
  if (!reason || reason.length > 500) {
    return res.status(400).json({ error: 'A correction reason of at most 500 characters is required' });
  }
  if (action === 'adjust' && (!SIGNED_POINTS.test(rawPoints) || Number(rawPoints) === 0 || !UUID.test(correctionKey))) {
    return res.status(400).json({ error: 'A signed non-zero points value and correction key are required' });
  }
  const actor = context.tenantUserId
    ? `tenant_user:${context.tenantUserId}` : `member:${context.memberId}`;
  const { data, error } = await deps.db.rpc('correct_member_cpd_points', {
    p_tenant_id: context.tenantId,
    p_member_id: memberId,
    p_ledger_entry_id: ledgerEntryId,
    p_action: action,
    p_points_value: action === 'adjust' ? rawPoints : null,
    p_reason: reason,
    p_actor: actor,
    p_correction_key: action === 'adjust' ? correctionKey : null,
  });
  if (error) {
    const validation = /required|not found|duplicate CPD correction|invalid linked/i.test(error.message || '');
    return res.status(validation ? 400 : 500).json({
      error: validation ? error.message : 'Failed to correct CPD points',
    });
  }
  return res.status(201).json({ entry: publicEntry(data) });
  };
}

export default createMemberCpdPointsHandler();