import { supabase } from '../_lib/database.js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';
import { getSessionMember } from '../_lib/session.js';
import { consentData, consentHash, eligibleEventRegistrationCategories } from '../_lib/eventRegistrationConsent.js';

export function createEventRegistrationConsentHandler({
  db = supabase, resolveTenant = resolveTenantFromRequest, sessionMember = getSessionMember,
} = {}) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    try {
      const { id, token, action, category_ids: ids = [] } = req.body || {};
      if (!['choices','subscribe','dismiss'].includes(action) || typeof token !== 'string'
          || !/^[A-Za-z0-9_-]{43}$/.test(token) || !Array.isArray(ids) || ids.length > 100)
        return res.status(400).json({ error: 'Invalid request' });
      const tenant = await resolveTenant(req);
      if (!tenant) return res.status(404).json({ error: 'Offer unavailable' });
      const offer = await consentData(db.from('event_registration_consent').select('*')
        .eq('tenant_id', tenant.id).eq('id', id).eq('token_hash', consentHash(token)).maybeSingle());
      if (!offer || Date.parse(offer.expires_at) <= Date.now())
        return res.status(410).json({ error: 'Offer unavailable' });
      const member = await sessionMember(req);
      if (offer.member_id ? member?.id !== offer.member_id
          || (member.tenant_id || member.organization?.tenant_id) !== offer.tenant_id : Boolean(member))
        return res.status(403).json({ error: 'Offer unavailable' });
      if (offer.completed_at) return res.json({ completed: true, categories: [] });
      const categories = await eligibleEventRegistrationCategories(db, offer);
      if (action === 'choices') return res.json({ categories });
      if (action === 'subscribe' && (!ids.length || ids.some(id => !categories.some(c => c.id === id))))
        return res.status(409).json({ error: 'These choices are no longer available. Your registration is unchanged.' });
      await consentData(db.rpc('complete_event_registration_consent', {
        p_id: offer.id, p_token_hash: offer.token_hash, p_member_id: offer.member_id,
        p_category_ids: action === 'dismiss' ? [] : [...new Set(ids)],
      }));
      return res.json({ completed: true });
    } catch {
      return res.status(503).json({ error: 'Preferences could not be updated. Your registration is unchanged.' });
    }
  };
}
export default createEventRegistrationConsentHandler();
