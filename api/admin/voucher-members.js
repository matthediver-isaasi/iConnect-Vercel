import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import { escapeLikeLiteral } from '../_lib/externalSubscriberPreferences.js';

export function applyVoucherMemberSearch(db, tenantId, search) {
  const pattern = JSON.stringify(`%${escapeLikeLiteral(search)}%`);
  return db.from('member').select('id, first_name, last_name, email')
    .eq('tenant_id', tenantId)
    .or(['first_name', 'last_name', 'email'].map(field => `${field}.ilike.${pattern}`).join(','))
    .order('last_name').limit(50);
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const ctx = await getTenantContext(req);
  if (ctx?.tenantMismatch) return res.status(409).json({ code: 'TENANT_CONTEXT_CHANGED', error: 'Tenant context changed. Reload before continuing.' });
  if (!ctx?.isAuthenticated || !ctx.tenantId || !(await hasAdminAccess(ctx))) {
    return res.status(403).json({ error: 'Tenant administrator access required' });
  }
  if (req.query?.ids) {
    const ids = [...new Set(String(req.query.ids).split(','))];
    if (ids.length > 200 || ids.some(id => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))) return res.status(400).json({ error: 'Invalid member identifiers' });
    const { data, error } = await supabase.from('member').select('id, first_name, last_name, email').eq('tenant_id', ctx.tenantId).in('id', ids);
    if (error) return res.status(500).json({ error: 'Unable to load member owners' });
    return res.status(200).json({ members: data });
  }
  const search = String(req.query?.search || '').trim().slice(0, 200);
  if (search.length < 2) return res.status(200).json({ members: [] });
  const { data, error } = await applyVoucherMemberSearch(supabase, ctx.tenantId, search);
  if (error) return res.status(500).json({ error: 'Unable to search tenant members' });
  return res.status(200).json({ members: data });
}
