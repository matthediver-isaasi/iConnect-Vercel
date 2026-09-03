import { createClient } from '@supabase/supabase-js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import { resolveFormAccess, sendFormAccessDenied } from '../_lib/formAccessPolicy.js';
import { isFormScheduleAvailable } from '../_lib/formAvailability.js';
import { lookupIdealPostcodes, normalizeUkPostcode } from '../_lib/idealPostcodes.js';

const FORM_COLUMNS = 'id, tenant_id, slug, is_active, deactivate_at, deactivate_timezone, access_policy, fields';
const trustedClientAddress = req => {
  // Vercel overwrites x-vercel-forwarded-for at its edge. Never mix a
  // caller-controlled forwarding header into that identity, because doing so
  // would let callers rotate rate-limit buckets. Local/dev traffic falls back
  // to the direct peer address rather than ordinary x-forwarded-for.
  const address = req.headers['x-vercel-forwarded-for']
    || req.socket?.remoteAddress
    || 'unknown';
  return String(address).split(',')[0].trim().slice(0, 100);
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const postcode = normalizeUkPostcode(req.body?.postcode);
  if (!postcode) return res.status(400).json({ error: 'Enter a valid UK postcode' });
  const formId = typeof req.body?.form_id === 'string' ? req.body.form_id : null;
  const formSlug = typeof req.body?.form_slug === 'string' ? req.body.form_slug : null;
  const fieldId = typeof req.body?.field_id === 'string' ? req.body.field_id : null;
  if (!formId && !formSlug) return res.status(400).json({ error: 'Form context is required' });
  if (!fieldId) return res.status(400).json({ error: 'Address field context is required' });
  if (!process.env.IDEAL_POSTCODES_API_KEY) {
    return res.status(503).json({ error: 'Address lookup is currently unavailable', code: 'ADDRESS_LOOKUP_UNAVAILABLE' });
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return res.status(503).json({ error: 'Database not configured' });
  }
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  try {
    // A form ID alone is only safe for an administrator in the resolved tenant.
    // Public callers must also be constrained by their request-resolved tenant.
    const context = await getTenantContext(req);
    const isAdmin = context?.isAuthenticated && context?.tenantId && await hasAdminAccess(context);
    let tenantId;
    let formQuery = db.from('form').select(FORM_COLUMNS);
    if (isAdmin) {
      tenantId = context.tenantId;
      formQuery = formQuery.eq('tenant_id', tenantId);
    } else {
      const tenant = await resolveTenantFromRequest(req);
      if (!tenant) return res.status(404).json({ error: 'Form not found' });
      tenantId = tenant.id;
      formQuery = formQuery.eq('tenant_id', tenantId).eq('is_active', true);
    }
    formQuery = formId ? formQuery.eq('id', formId) : formQuery.eq('slug', formSlug);
    const { data: form, error: formError } = await formQuery.maybeSingle();
    if (formError || !form || (!isAdmin && !isFormScheduleAvailable(form))) {
      return res.status(404).json({ error: 'Form not found' });
    }
    const addressField = (form.fields || []).find(field =>
      String(field?.id) === fieldId && field?.type === 'address_lookup');
    if (!addressField) return res.status(404).json({ error: 'Address field not found' });
    if (!isAdmin) {
      const access = await resolveFormAccess({ supabase: db, req, tenantId, policy: form.access_policy });
      if (!access.allowed) return sendFormAccessDenied(res, access);
    }
    const { data: integration, error: integrationError } = await db.from('tenant_integrations')
      .select('is_enabled').eq('tenant_id', tenantId).eq('integration_type', 'ideal_postcodes').maybeSingle();
    if (integrationError) throw integrationError;
    if (!integration?.is_enabled) {
      return res.status(403).json({ error: 'Address lookup is not enabled for this tenant', code: 'ADDRESS_LOOKUP_DISABLED' });
    }
    const { data: rateLimitAllowed, error: rateLimitError } = await db.rpc(
      'consume_address_lookup_rate_limit',
      {
        p_tenant_id: tenantId,
        p_form_id: form.id,
        p_client_key: trustedClientAddress(req),
        p_limit: 20,
        p_window_seconds: 60,
      },
    );
    if (rateLimitError) throw rateLimitError;
    if (rateLimitAllowed !== true) {
      return res.status(429).json({
        error: 'Too many address searches. Please try again shortly.',
        code: 'ADDRESS_LOOKUP_RATE_LIMITED',
      });
    }
    const addresses = await lookupIdealPostcodes(postcode, process.env.IDEAL_POSTCODES_API_KEY);
    return res.status(200).json({ addresses });
  } catch (error) {
    // Never include an upstream body/URL: either can include the platform key.
    console.error('[Address lookup] request failed:', error?.message);
    return res.status(502).json({ error: 'Address lookup is currently unavailable', code: 'ADDRESS_LOOKUP_UNAVAILABLE' });
  }
}