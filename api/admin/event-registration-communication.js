import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import { consentData } from '../_lib/eventRegistrationConsent.js';

export function createEventRegistrationCommunicationHandler({
  db = supabase, tenantContext = getTenantContext, adminAccess = hasAdminAccess,
} = {}) {
return async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!['GET','PUT'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  try {
    const ctx = await tenantContext(req);
    if (!ctx?.isAuthenticated || ctx.tenantMismatch || !ctx.tenantId || !await adminAccess(ctx))
      return res.status(403).json({ error: 'Event administrator permission is required' });
    const input = req.method === 'GET' ? req.query : req.body;
    const { event_id: eventId, event_kind: kind } = input || {};
    if (!['simple','complex'].includes(kind)) return res.status(400).json({ error: 'Invalid event kind' });
    if (eventId) {
      const event = await consentData(db.from(kind === 'simple' ? 'event' : 'complex_event').select('id')
        .eq('tenant_id', ctx.tenantId).eq('id', eventId).maybeSingle());
      if (!event) return res.status(404).json({ error: 'Event unavailable' });
    }
    if (req.method === 'PUT') {
      const ids = input.category_ids;
      if (!eventId || !Array.isArray(ids) || ids.length > 100 || ids.some(id => typeof id !== 'string'))
        return res.status(400).json({ error: 'Invalid selections' });
      const categories = await consentData(db.from('communication_category').select('id')
        .eq('tenant_id', ctx.tenantId).eq('is_active', true));
      if (ids.some(id => !categories.some(c => c.id === id)))
        return res.status(400).json({ error: 'One or more categories are unavailable' });
      await consentData(db.rpc('set_event_registration_communication', {
        p_tenant_id: ctx.tenantId, p_event_kind: kind, p_event_id: eventId, p_category_ids: [...new Set(ids)],
      }));
      return res.json({ success: true });
    }
    const categories = await consentData(db.from('communication_category').select('id,name')
      .eq('tenant_id', ctx.tenantId).eq('is_active', true).order('display_order'));
    const config = eventId ? await consentData(db.from('event_registration_communication').select('category_ids')
      .eq('tenant_id', ctx.tenantId).eq('event_kind', kind).eq('event_id', eventId).maybeSingle()) : null;
    return res.json({ categories, category_ids: config?.category_ids || [] });
  } catch {
    return res.status(503).json({ error: 'Communication settings could not be saved or loaded' });
  }
};
}
export default createEventRegistrationCommunicationHandler();
