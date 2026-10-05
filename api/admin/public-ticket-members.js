import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import { recoverPublicTicketPurchase } from '../_lib/publicTicketMemberRecovery.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  try {
    const context = await getTenantContext(req);
    if (!context.tenantId || !await hasAdminAccess(context)) return res.status(403).json({ error: 'Administrator access required' });
    if (req.method === 'GET') {
      if (!req.query.event_id) return res.status(400).json({ error: 'Event is required' });
      const { data, error } = await supabase.from('public_ticket_member_purchase')
        .select('id,event_id,event_kind,state,attempts,last_error_code,created_at,updated_at,completed_at')
        .eq('tenant_id', context.tenantId).eq('event_id', req.query.event_id)
        .order('created_at', { ascending: false }).limit(50);
      if (error) throw error;
      return res.status(200).json({ purchases: data });
    }
    const { data: purchase, error } = await supabase.from('public_ticket_member_purchase')
      .select('*').eq('tenant_id', context.tenantId).eq('id', req.body?.purchase_id).maybeSingle();
    if (error) throw error;
    if (!purchase) return res.status(404).json({ error: 'Purchase not found' });
    if (purchase.state === 'conflict' && purchase.last_error_code === 'role_policy_conflict') {
      const { error: resetError } = await supabase.from('public_ticket_member_purchase')
        .update({ state: 'retryable', updated_at: new Date().toISOString() })
        .eq('id', purchase.id).eq('tenant_id', context.tenantId)
        .eq('state', 'conflict').eq('last_error_code', 'role_policy_conflict');
      if (resetError) throw resetError;
      purchase.state = 'retryable';
    }
    return res.status(200).json(await recoverPublicTicketPurchase(supabase, purchase));
  } catch {
    return res.status(503).json({ error: 'Unable to inspect or retry ticket member creation' });
  }
}
