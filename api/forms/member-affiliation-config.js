import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import { discoverMemberAffiliations, validateMemberAffiliationConfig } from '../_lib/formMemberAffiliationConfig.js';

export default async function handler(req, res, deps = {}) {
  res.setHeader('Cache-Control', 'no-store');
  if (!['GET', 'PUT'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  try {
    const context = await (deps.getTenantContext || getTenantContext)(req);
    if (!context || !await (deps.hasAdminAccess || hasAdminAccess)(context)) return res.status(403).json({ error: 'Administrator access required' });
    const tenantId = context.effectiveTenantId || context.tenantId;
    if (!tenantId) return res.status(403).json({ error: 'Tenant context required' });
    const db = deps.db || supabase;
    const formId = req.method === 'GET' ? req.query?.form_id : req.body?.form_id;
    const { data: form, error } = await db.from('form').select('*').eq('tenant_id', tenantId).eq('id', formId).maybeSingle();
    if (error) throw error;
    if (!form) return res.status(404).json({ error: 'Form not found' });
    if (req.method === 'GET') {
      const { data, error: configError } = await db.from('form_member_affiliation_config').select('config')
        .eq('tenant_id', tenantId).eq('form_id', formId).maybeSingle();
      if (configError) throw configError;
      return res.status(200).json({ config: data?.config || null });
    }
    const { data: existing, error: existingError } = await db.from('form_member_affiliation_config').select('config')
      .eq('tenant_id', tenantId).eq('form_id', formId).maybeSingle();
    if (existingError) throw existingError;
    if (existing?.config?.purpose === 'profile') {
      return res.status(409).json({ error: 'This standalone profile form uses verified affiliation bindings. Edit its fields normally; changing its bindings requires a new verified adaptation.' });
    }
    const metadata = await discoverMemberAffiliations(db, tenantId);
    let config;
    try { config = validateMemberAffiliationConfig(form, req.body?.config, metadata); }
    catch (validationError) { return res.status(400).json({ error: validationError.message }); }
    const { data, error: saveError } = await db.rpc('configure_form_member_affiliations', {
      p_tenant_id: tenantId, p_form_id: formId, p_config: config,
    });
    if (saveError) throw saveError;
    return res.status(200).json({ config: data });
  } catch {
    return res.status(503).json({ error: 'Affiliation configuration could not be loaded or saved. Check that its database migrations are installed.' });
  }
}
