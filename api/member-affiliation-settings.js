import { supabase } from './_lib/database.js';
import { getTenantContext, hasAdminAccess } from './_lib/tenantContext.js';
import { discoverMemberAffiliations } from './_lib/formMemberAffiliationConfig.js';
import { loadProfilePolicy } from './_lib/profileAffiliations.js';
import { validateProfileAffiliationConfig } from './_lib/profileAffiliationPolicy.js';

export default async function handler(req, res, deps = {}) {
  res.setHeader('Cache-Control', 'no-store');
  if (!['GET', 'PUT'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  try {
    const db = deps.db || supabase;
    const context = await (deps.getTenantContext || getTenantContext)(req);
    const tenantId = context?.effectiveTenantId || context?.tenantId;
    if (!context?.isAuthenticated || context.tenantMismatch || !tenantId
      || !await (deps.hasAdminAccess || hasAdminAccess)(context)) {
      return res.status(403).json({ error: 'Administrator access required.' });
    }
    const metadata = await (deps.discover || discoverMemberAffiliations)(db, tenantId);
    let policy = await loadProfilePolicy(db, tenantId);
    if (req.method === 'PUT') {
      if (!Number.isSafeInteger(req.body?.version) || req.body.version < 0) return res.status(400).json({ error: 'Reload the settings before saving.' });
      let config;
      try { config = validateProfileAffiliationConfig(req.body.config, metadata); }
      catch (error) { return res.status(400).json({ error: error.message }); }
      const { data, error } = await db.rpc('profile_affiliation_policy_save', {
        p_tenant: tenantId, p_version: req.body.version, p_config: config,
      });
      if (error) throw error;
      policy = data;
    }
    return res.json({ version: policy.version, config: policy.config, metadata });
  } catch (error) {
    return res.status(error.code === '40001' ? 409 : 503).json({
      error: error.code === '40001' ? 'Settings changed. Reload before saving.' : 'Affiliation settings could not be loaded or saved. Editing remains unavailable.',
    });
  }
}
