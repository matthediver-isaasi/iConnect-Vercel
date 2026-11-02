import { supabase } from '../_lib/database.js';
import { resolveCategories } from '@cookieyes/core';
import { CONSENT_CATEGORIES } from '../../shared/cookieConsent.js';
import { resolveConsentRequest, sameOrigin, validateConsentRecord, policyFingerprint } from '../_lib/cookieConsent.js';

export const config = { api: { bodyParser: { sizeLimit: '4kb' } } };
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!['GET','POST'].includes(req.method)) return res.status(405).end();
  try {
    const context = await resolveConsentRequest(req);
    const { host, tenant, effective, active } = context;
    const revision = policyFingerprint(effective, tenant.settings?.ga4_measurement_id || null);
    if (req.method === 'GET') return res.json({
      config: effective, active, tenantId: tenant.id, tenantSlug:tenant.slug, host, revision,
      ga4MeasurementId: tenant.settings?.ga4_measurement_id || null,
      primaryColor: tenant.primary_color || null,
    });
    if (!sameOrigin(req, host) || !active) return res.status(403).json({ error: 'Consent recording unavailable for this context' });
    let row;
    try { row = validateConsentRecord(req.body, { host, policyVersion: effective.policyVersion, revision, taxonomyHash: resolveCategories(CONSENT_CATEGORIES).taxonomyHash }); }
    catch { return res.status(400).json({error:'Invalid consent record'}); }
    const { data, error } = await supabase.rpc('ingest_cookie_consent', { p_tenant: tenant.id, p_record: row });
    if (error) throw error;
    if (!data) return res.status(429).json({ error: 'Consent recording capacity reached' });
    return res.status(204).end();
  } catch {
    return res.status(503).json({ error: 'Consent configuration or recording unavailable' });
  }
}
