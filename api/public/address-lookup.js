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
const elapsedMs = startedAt => Math.round((performance.now() - startedAt) * 10) / 10;
const hasAuthCredentials = req => (
  /^Bearer\s+\S+/i.test(String(req.headers.authorization || ''))
  || /(?:^|;\s*)iconnect\.sid=/.test(String(req.headers.cookie || ''))
);

export default async function handler(req, res) {
  const requestStartedAt = performance.now();
  const timings = {};
  const reportTimings = outcome => {
    const totalMs = elapsedMs(requestStartedAt);
    const stages = Object.entries({ ...timings, total: totalMs })
      .map(([name, duration]) => `${name};dur=${duration}`)
      .join(', ');
    res.setHeader('Server-Timing', stages);
    console.info('[Address lookup timing]', JSON.stringify({ ...timings, totalMs, outcome }));
  };
  const respondJson = (status, payload, outcome) => {
    reportTimings(outcome);
    return res.status(status).json(payload);
  };
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    reportTimings('preflight');
    return res.status(200).end();
  }
  if (req.method !== 'POST') return respondJson(405, { error: 'Method not allowed' }, 'method_not_allowed');

  const postcode = normalizeUkPostcode(req.body?.postcode);
  if (!postcode) return respondJson(400, { error: 'Enter a valid UK postcode' }, 'invalid_postcode');
  const formId = typeof req.body?.form_id === 'string' ? req.body.form_id : null;
  const formSlug = typeof req.body?.form_slug === 'string' ? req.body.form_slug : null;
  const fieldId = typeof req.body?.field_id === 'string' ? req.body.field_id : null;
  if (!formId && !formSlug) {
    return respondJson(400, { error: 'Form context is required' }, 'missing_form_context');
  }
  if (!fieldId) {
    return respondJson(400, { error: 'Address field context is required' }, 'missing_field_context');
  }
  if (!process.env.IDEAL_POSTCODES_API_KEY) {
    return respondJson(503, {
      error: 'Address lookup is currently unavailable',
      code: 'ADDRESS_LOOKUP_UNAVAILABLE',
    }, 'provider_not_configured');
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return respondJson(503, { error: 'Database not configured' }, 'database_not_configured');
  }
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  try {
    // A form ID alone is only safe for an administrator in the resolved tenant.
    // Public callers must also be constrained by their request-resolved tenant.
    const contextStartedAt = performance.now();
    const context = hasAuthCredentials(req) ? await getTenantContext(req) : null;
    const isAdmin = context?.isAuthenticated && context?.tenantId && await hasAdminAccess(context);
    timings.context = elapsedMs(contextStartedAt);
    let tenantId;
    let formQuery = db.from('form').select(FORM_COLUMNS);
    const tenantStartedAt = performance.now();
    if (isAdmin) {
      tenantId = context.tenantId;
      formQuery = formQuery.eq('tenant_id', tenantId);
    } else {
      const tenant = await resolveTenantFromRequest(req);
      if (!tenant) return respondJson(404, { error: 'Form not found' }, 'tenant_not_found');
      tenantId = tenant.id;
      formQuery = formQuery.eq('tenant_id', tenantId).eq('is_active', true);
    }
    timings.tenant = elapsedMs(tenantStartedAt);
    formQuery = formId ? formQuery.eq('id', formId) : formQuery.eq('slug', formSlug);
    const formStartedAt = performance.now();
    const { data: form, error: formError } = await formQuery.maybeSingle();
    timings.form = elapsedMs(formStartedAt);
    if (formError || !form || (!isAdmin && !isFormScheduleAvailable(form))) {
      return respondJson(404, { error: 'Form not found' }, 'form_not_found');
    }
    const addressField = (form.fields || []).find(field =>
      String(field?.id) === fieldId && field?.type === 'address_lookup');
    if (!addressField) {
      return respondJson(404, { error: 'Address field not found' }, 'address_field_not_found');
    }
    const checksStartedAt = performance.now();
    const [access, integrationResult] = await Promise.all([
      isAdmin
        ? Promise.resolve({ allowed: true })
        : resolveFormAccess({ supabase: db, req, tenantId, policy: form.access_policy }),
      db.from('tenant_integrations')
        .select('is_enabled').eq('tenant_id', tenantId).eq('integration_type', 'ideal_postcodes').maybeSingle(),
    ]);
    timings.checks = elapsedMs(checksStartedAt);
    if (!access.allowed) {
      reportTimings('access_denied');
      return sendFormAccessDenied(res, access);
    }
    const { data: integration, error: integrationError } = integrationResult;
    if (integrationError) throw integrationError;
    if (!integration?.is_enabled) {
      return respondJson(403, {
        error: 'Address lookup is not enabled for this tenant',
        code: 'ADDRESS_LOOKUP_DISABLED',
      }, 'integration_disabled');
    }
    const rateLimitStartedAt = performance.now();
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
    timings.rateLimit = elapsedMs(rateLimitStartedAt);
    if (rateLimitError) throw rateLimitError;
    if (rateLimitAllowed !== true) {
      return respondJson(429, {
        error: 'Too many address searches. Please try again shortly.',
        code: 'ADDRESS_LOOKUP_RATE_LIMITED',
      }, 'rate_limited');
    }
    const providerStartedAt = performance.now();
    const addresses = await lookupIdealPostcodes(postcode, process.env.IDEAL_POSTCODES_API_KEY);
    timings.provider = elapsedMs(providerStartedAt);
    return respondJson(200, { addresses }, 'success');
  } catch (error) {
    // Never include an upstream body/URL: either can include the platform key.
    console.error('[Address lookup] request failed:', error?.message);
    return respondJson(502, {
      error: 'Address lookup is currently unavailable',
      code: 'ADDRESS_LOOKUP_UNAVAILABLE',
    }, 'unavailable');
  }
}