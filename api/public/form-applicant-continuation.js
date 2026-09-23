import { createClient } from '@supabase/supabase-js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';
import { verifyApplicantContinuation } from '../_lib/formApplicantContinuation.js';

export default async function handler(req, res, dependencies = {}) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const tenant = dependencies.tenantData || await resolveTenantFromRequest(req);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
    const db = dependencies.supabase || createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { data: form, error } = await db.from('form').select('*')
      .eq('tenant_id', tenant.id).eq('id', req.body?.form_id).eq('is_active', true).maybeSingle();
    if (error) throw error;
    if (!form) return res.status(404).json({ error: 'Form not found' });
    const grant = await verifyApplicantContinuation({ db, form,
      token: req.body?.applicant_continuation_token, resumeToken: req.body?.resume_token });
    return res.status(200).json({ form_id: grant.form_id,
      organization_id: grant.organization_id, expires_at: grant.expires_at });
  } catch (error) {
    return res.status(error.status || 500).json({
      error: error.status ? error.message : 'Unable to verify applicant link', code: error.code,
    });
  }
}