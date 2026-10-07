import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import { normalizeFormAlertSettings, FORM_ALERT_EXPIRY_DAYS } from '../../shared/formAlertSettings.js';
import { FORM_ALERTS_RELEASE_READY } from '../_lib/formAlertReleaseGate.js';

const uuid = value => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export default async function handler(req, res, deps = {}) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (!['GET', 'PUT', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  try {
    const context = await (deps.getTenantContext || getTenantContext)(req);
    if (!context?.isAuthenticated) return res.status(401).json({ error: 'Authentication required' });
    if (!context.tenantId || !await (deps.hasAdminAccess || hasAdminAccess)(context)) {
      return res.status(403).json({ error: 'Tenant administrator access required' });
    }
    const db = deps.db || supabase;
    const formId = req.query?.form_id || req.body?.form_id;
    if (!uuid(formId)) return res.status(400).json({ error: 'A form ID is required' });
    const { data: form, error } = await db.from('form').select('id')
      .eq('id', formId).eq('tenant_id', context.tenantId).maybeSingle();
    if (error) throw error;
    if (!form) return res.status(404).json({ error: 'Form unavailable' });
    if (req.method === 'POST') {
      if (req.body?.action !== 'revoke' || !uuid(req.body?.submission_id)) {
        return res.status(400).json({ error: 'A submission ID and revoke action are required' });
      }
      const { data: submission, error: lookupError } = await db.from('form_submission').select('id')
        .eq('id', req.body.submission_id).eq('tenant_id', context.tenantId).eq('form_id', formId).maybeSingle();
      if (lookupError) throw lookupError;
      if (!submission) return res.status(404).json({ error: 'Submission unavailable' });
      const { error: revokeError } = await db.rpc('revoke_form_submission_alerts', {
        p_tenant_id: context.tenantId, p_form_id: formId, p_submission_id: submission.id,
      });
      if (revokeError) throw revokeError;
      return res.status(200).json({ revoked: true });
    }
    if (req.method === 'PUT') {
      let settings;
      try { settings = normalizeFormAlertSettings(req.body); }
      catch (error) { return res.status(400).json({ error: error.message }); }
      if (settings.enabled && !FORM_ALERTS_RELEASE_READY) {
        return res.status(409).json({ error: 'Submission alerts are not available yet. Delivery and secure-response verification must be completed before enabling them.' });
      }
      const { error: saveError } = await db.from('form_alert_settings').upsert({
        tenant_id: context.tenantId, form_id: formId, ...settings,
      }, { onConflict: 'tenant_id,form_id' });
      if (saveError) throw saveError;
      return res.status(200).json({ ...settings, expires_in_days: FORM_ALERT_EXPIRY_DAYS, available: FORM_ALERTS_RELEASE_READY });
    }
    const { data, error: readError } = await db.from('form_alert_settings')
      .select('enabled,recipients').eq('tenant_id', context.tenantId).eq('form_id', formId).maybeSingle();
    if (readError) throw readError;
    return res.status(200).json({ enabled: data?.enabled === true, recipients: data?.recipients || [],
      expires_in_days: FORM_ALERT_EXPIRY_DAYS, available: FORM_ALERTS_RELEASE_READY });
  } catch {
    // Neither submitted addresses nor database/provider diagnostics belong in public errors.
    return res.status(503).json({ error: 'Form alert settings are temporarily unavailable' });
  }
}
