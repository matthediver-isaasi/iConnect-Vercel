import { createClient } from '@supabase/supabase-js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import { issueApplicantContinuation } from '../_lib/formApplicantContinuation.js';
import { getTrustedBaseUrlForTenant } from '../_lib/publicBaseUrl.js';

export default async function handler(req, res, dependencies = {}) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const context = await (dependencies.getTenantContext || getTenantContext)(req);
    if (!context || !await (dependencies.hasAdminAccess || hasAdminAccess)(context)) {
      return res.status(403).json({ error: 'Administrator access required' });
    }
    const tenantId = context.effectiveTenantId || context.tenantId;
    if (!tenantId) return res.status(403).json({ error: 'Tenant context required' });
    const db = dependencies.supabase || createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { data: form, error } = await db.from('form').select('*')
      .eq('tenant_id', tenantId).eq('id', req.body?.form_id).eq('is_active', true).maybeSingle();
    if (error) throw error;
    if (!form) return res.status(404).json({ error: 'Form not found' });
    const issued = await issueApplicantContinuation({
      db, form, organizationId: req.body?.organization_id,
    });
    const resolveBaseUrl = dependencies.getTrustedBaseUrlForTenant
      || getTrustedBaseUrlForTenant;
    const baseUrl = await resolveBaseUrl(req, db, tenantId);
    const applicantUrl = new URL('/FormView', `${baseUrl}/`);
    applicantUrl.searchParams.set('slug', form.slug);
    applicantUrl.searchParams.set(
      'applicant_continuation_token',
      issued.applicant_continuation_token,
    );
    return res.status(201).json({
      ...issued,
      resume_url: applicantUrl.toString(),
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      error: error.status ? error.message : 'Unable to issue applicant link', code: error.code,
    });
  }
}