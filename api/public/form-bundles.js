import { supabase } from '../_lib/database.js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';
import { getSessionMember } from '../_lib/session.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import { resolveFormAccess, sendFormAccessDenied } from '../_lib/formAccessPolicy.js';
import { isFormScheduleAvailable } from '../_lib/formAvailability.js';
import { bundleOptions, FormBundleError } from '../_lib/formBundles.js';

export async function formBundlesHandler(req, res, dependencies = {}) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const db = dependencies.db || supabase;
  try {
    const tenant = await (dependencies.resolveTenant || resolveTenantFromRequest)(req);
    if (!tenant?.id) return res.status(404).json({ error: 'Form not found' });
    const { data: form, error } = await db.from('form').select('*').eq('tenant_id', tenant.id)
      .eq('id', req.query?.form_id).eq('is_active', true).maybeSingle();
    if (error) throw error;
    if (!form || !isFormScheduleAvailable(form) || form.form_type === 'survey') return res.status(404).json({ error: 'Form unavailable' });
    const access = await (dependencies.resolveAccess || resolveFormAccess)({
      supabase: db, req, tenantId: tenant.id, policy: form.access_policy,
    });
    if (!access.allowed) return sendFormAccessDenied(res, access);
    if (form.require_authentication || form.mutation_access_policy?.mode === 'authenticated_owner') {
      const member = await (dependencies.getSessionMember || getSessionMember)(req);
      const context = await (dependencies.getTenantContext || getTenantContext)(req);
      if ((member?.tenant_id || member?.organization?.tenant_id) !== tenant.id
        && !(context?.tenantId === tenant.id && await (dependencies.hasAdminAccess || hasAdminAccess)(context))) {
        return res.status(403).json({ error: 'Sign in to access this form' });
      }
    }
    return res.status(200).json({ items: await bundleOptions(db, form, req.query?.field_id) });
  } catch (error) {
    return res.status(error instanceof FormBundleError ? error.status : 500).json({
      error: error instanceof FormBundleError ? error.message : 'Bundle availability could not be loaded',
      code: error instanceof FormBundleError ? error.code : 'BUNDLE_OPTIONS_FAILED',
    });
  }
}
export default formBundlesHandler;
