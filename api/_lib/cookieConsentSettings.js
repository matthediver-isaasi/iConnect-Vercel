import { supabase } from './database.js';
import { getTenantContext } from './tenantContext.js';
import { getSessionTenantUser } from './session.js';
import { getSessionPlatformOwner } from './platformSession.js';
import { validateConsentOverrides, effectiveConsentConfig, consentComplete } from '../../shared/cookieConsent.js';

export function consentSettingsHandler(platform) {
  return async (req, res) => {
    res.setHeader('Cache-Control','no-store');
    try {
      let tenantId = null;
      if (platform) {
        if (!await getSessionPlatformOwner(req)) return res.status(403).end();
      } else {
        const ctx = await getTenantContext(req);
        const user = await getSessionTenantUser(req);
        if (!ctx?.isAuthenticated || !user || (user._sessionTenantId || user.tenant_id) !== ctx.tenantId || !['admin','owner','super_admin'].includes(user.role)) return res.status(403).end();
        tenantId = ctx.tenantId;
      }
      if (req.method === 'PUT') {
        try {
          if (new URL(req.headers.origin).host !== req.headers.host) return res.status(403).end();
        } catch { return res.status(403).end(); }
        let overrides;
        try { overrides = validateConsentOverrides(req.body?.overrides, platform); }
        catch (error) { return res.status(400).json({error:error.message}); }
        const { error } = await supabase.rpc('set_cookie_consent_settings', { p_tenant: tenantId, p_value: overrides });
        if (error) throw error;
      } else if (req.method !== 'GET') return res.status(405).end();
      const { data: pref, error: pe } = await supabase.from('platform_preferences').select('value').eq('key','cookie_consent').maybeSingle();
      if (pe) throw pe;
      if (platform) {
        let tenants = [];
        for (let start=0; ; start+=500) {
          const { data, error } = await supabase.from('tenant').select('id,name,settings').order('id').range(start,start+499);
          if (error) throw error;
          tenants.push(...data.map(t => {
            const c = effectiveConsentConfig(pref?.value || {}, t.settings?.cookie_consent || {});
            return {id:t.id,name:t.name,complete:consentComplete(c),active:c.enabled && c.pilotTenantIds.includes(t.id) && consentComplete(c)};
          }));
          if (data.length < 500) break;
        }
        return res.json({overrides:pref?.value || {},effective:effectiveConsentConfig(pref?.value || {}),tenants});
      }
      const { data: tenant, error } = await supabase.from('tenant').select('settings').eq('id',tenantId).single();
      if (error) throw error;
      return res.json({overrides:tenant.settings?.cookie_consent || {},effective:effectiveConsentConfig(pref?.value || {},tenant.settings?.cookie_consent || {}),ga4MeasurementId:tenant.settings?.ga4_measurement_id || null});
    } catch { return res.status(503).json({error:'Unable to load or save cookie consent settings'}); }
  };
}
