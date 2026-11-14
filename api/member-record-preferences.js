import { supabase } from './_lib/database.js';
import { getTenantContext } from './_lib/tenantContext.js';
import { memberBalancesVisible } from '../shared/memberBalancesVisibility.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const context = await getTenantContext(req);
    if (!context?.isAuthenticated || !context.tenantId || context.tenantMismatch) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (req.headers['x-tenant-id'] && req.headers['x-tenant-id'] !== context.tenantId) {
      return res.status(409).json({ code: 'TENANT_CONTEXT_CHANGED' });
    }
    const { data, error } = await supabase.from('tenant').select('settings')
      .eq('id', context.tenantId).single();
    if (error || !data) throw new Error('Settings unavailable');
    return res.status(200).json({
      tenantId: context.tenantId,
      show_member_balances_tab: memberBalancesVisible(data.settings ?? {}),
    });
  } catch {
    return res.status(503).json({ error: 'Member record preferences unavailable' });
  }
}
