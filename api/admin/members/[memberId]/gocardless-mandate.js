import { supabase } from '../../../_lib/database.js';
import {
  checkCrossMemberPermissions,
  getTenantContext,
  hasAdminAccess,
} from '../../../_lib/tenantContext.js';
import { selectCurrentMemberMandate } from '../../../_lib/memberGocardlessMandate.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });

  try {
    const context = await getTenantContext(req);
    if (!context?.isAuthenticated || !context.tenantId || context.tenantMismatch) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    const admin = await hasAdminAccess(context);
    const { hasCrossMemberAccess } = admin
      ? { hasCrossMemberAccess: true }
      : await checkCrossMemberPermissions(context.roleId);
    if (!hasCrossMemberAccess) {
      return res.status(403).json({ error: 'Member management access required' });
    }

    const { memberId } = req.query;
    const { data: member, error: memberError } = await supabase
      .from('member')
      .select('id, tenant_id')
      .eq('id', memberId)
      .eq('tenant_id', context.tenantId)
      .maybeSingle();
    if (memberError) throw memberError;
    if (!member) return res.status(404).json({ error: 'Member not found' });

    const { data: agreements, error: agreementError } = await supabase
      .from('membership_billing_agreements')
      .select('id, tenant_id, member_id, organization_id, agreement_type, gocardless_mandate_id, created_at')
      .eq('tenant_id', context.tenantId)
      .eq('member_id', memberId)
      .eq('agreement_type', 'member')
      .is('organization_id', null)
      .order('created_at', { ascending: false });
    if (agreementError) throw agreementError;

    const agreementIds = (agreements || []).map(row => row.id);
    let plans = [];
    if (agreementIds.length) {
      const { data, error } = await supabase
        .from('membership_payment_plans')
        .select('id, billing_agreement_id, organization_id, gocardless_mandate_id, status, created_at')
        .eq('tenant_id', context.tenantId)
        .in('billing_agreement_id', agreementIds);
      if (error) throw error;
      plans = data || [];
    }

    const candidateIds = [...new Set([
      ...(agreements || []).map(row => row.gocardless_mandate_id),
      ...plans.map(row => row.gocardless_mandate_id),
    ].filter(Boolean))];
    let mandates = [];
    if (candidateIds.length) {
      const { data, error } = await supabase
        .from('gocardless_mandates')
        .select('tenant_id, gocardless_mandate_id, status')
        .eq('tenant_id', context.tenantId)
        .in('gocardless_mandate_id', candidateIds);
      if (error) throw error;
      mandates = data || [];
    }

    return res.json(selectCurrentMemberMandate({
      memberId,
      agreements: agreements || [],
      plans,
      mandates,
    }));
  } catch (error) {
    console.error('[Member GoCardless Mandate] Error:', error);
    return res.status(500).json({ error: 'Failed to load GoCardless mandate' });
  }
}