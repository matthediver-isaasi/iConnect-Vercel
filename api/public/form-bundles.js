import { supabase } from '../_lib/database.js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';
import { getSessionMember } from '../_lib/session.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import { resolveFormAccess, sendFormAccessDenied } from '../_lib/formAccessPolicy.js';
import { isFormScheduleAvailable } from '../_lib/formAvailability.js';
import { bundleOptions, FormBundleError } from '../_lib/formBundles.js';
import { cartOptions, FormCartError } from '../_lib/formCart.js';
import { cartField } from '../../shared/formCart.js';
import { shoppingHoldsReady, readShoppingHold, withOwnStock, updateShoppingHold } from '../_lib/formCartShoppingHold.js';

export async function formBundlesHandler(req, res, dependencies = {}) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  const db = dependencies.db || supabase;
  try {
    const tenant = await (dependencies.resolveTenant || resolveTenantFromRequest)(req);
    if (!tenant?.id) return res.status(404).json({ error: 'Form not found' });
    const { data: form, error } = await db.from('form').select('*').eq('tenant_id', tenant.id)
      .eq('id', req.query?.form_id || req.body?.form_id).eq('is_active', true).maybeSingle();
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
    const field = cartField(form);
    const fieldId = req.query?.field_id || req.body?.field_id;
    if (req.method === 'POST') {
      if (!field || field.id !== fieldId) return res.status(404).json({ error: 'Cart not found' });
      try {
        const options = req.body.action === 'reserve' ? await cartOptions(db, form, fieldId) : [];
        const reservation = await updateShoppingHold(db, form, field, req.body, options, dependencies);
        return res.status(200).json({ reservation });
      } catch (error) {
        return res.status(409).json({ error: error instanceof Error ? error.message : 'Your reservation could not be updated. Refresh the cart and try again.' });
      }
    }
    const ready = field ? await shoppingHoldsReady(db) : false;
    const reservation = ready && req.query?.reservation_id
      ? await readShoppingHold(db, form, req.query.reservation_id) : null;
    const items = await (field ? cartOptions : bundleOptions)(db, form, fieldId);
    return res.status(200).json({ items: withOwnStock(items, reservation),
      ...(field ? { reservationReady: ready, reservation } : {}) });
  } catch (error) {
    const known = error instanceof FormBundleError || error instanceof FormCartError;
    return res.status(known ? error.status : 500).json({
      error: known ? error.message : 'Catalogue availability could not be loaded',
      code: known ? error.code : 'BUNDLE_OPTIONS_FAILED',
    });
  }
}
export default formBundlesHandler;
