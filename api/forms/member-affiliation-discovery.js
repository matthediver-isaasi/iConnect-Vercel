import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import { discoverMemberAffiliations } from '../_lib/formMemberAffiliationConfig.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const context = await getTenantContext(req);
    if (!context || !await hasAdminAccess(context)) return res.status(403).json({ error: 'Administrator access required' });
    const tenantId = context.effectiveTenantId || context.tenantId;
    if (!tenantId) return res.status(403).json({ error: 'Tenant context required' });
    const { data: form, error } = await supabase.from('form').select('id').eq('tenant_id', tenantId).eq('id', req.query?.form_id).maybeSingle();
    if (error) throw error;
    if (!form) return res.status(404).json({ error: 'Form not found' });
    return res.status(200).json(await discoverMemberAffiliations(supabase, tenantId));
  } catch {
    return res.status(503).json({ error: 'Complete affiliation choices could not be loaded. Please retry.' });
  }
}
