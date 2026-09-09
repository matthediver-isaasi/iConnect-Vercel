import { createClient } from '@supabase/supabase-js';
import { sendSubmissionEmailsGuarded } from '../_lib/formSubmissionEmails.js';
import { getTrustedBaseUrlForTenant } from '../_lib/publicBaseUrl.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

const supabase = supabaseUrl && supabaseServiceKey
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

// Task #3190: this endpoint is now a thin wrapper over the shared
// api/_lib/formSubmissionEmails.js sender. Submission emails are sent
// server-side by api/public/form-submission.js at creation time; this
// retained client call is a backstop for older cached clients and CANNOT
// double-send: the shared sender claims form_submission.submission_email_state
// atomically, so if the server-side path already processed the submission this
// returns { skipped: true, alreadyProcessed: true } without sending.

export async function handleSendSubmissionEmail(req, res, dependencies = {}) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const database = dependencies.supabase || supabase;
  const submissionEmailSender = dependencies.sendSubmissionEmailsGuarded
    || sendSubmissionEmailsGuarded;
  if (!database) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  try {
    console.log('[FormSubmissionEmail] === ENDPOINT CALLED ===');

    const {
      form_id,
      submission_id,
      force_resend,            // Task #3194: admin rerun — resend already-sent emails
    } = req.body;

    console.log('[FormSubmissionEmail] Request received for form:', form_id, 'submission:', submission_id);

    if (!form_id || !submission_id) {
      return res.status(400).json({ error: 'form_id and submission_id are required' });
    }

    // Get the form with email settings
    const { data: form, error: formError } = await database
      .from('form')
      .select('*, tenant_id')
      .eq('id', form_id)
      .single();

    if (formError || !form) {
      console.log('[FormSubmissionEmail] Form not found:', form_id, formError);
      return res.status(404).json({ error: 'Form not found' });
    }

    // The browser body is not authoritative. Bind this send to the persisted
    // row and use only its server-owned tenant, form, values, and linked IDs.
    const { data: submission, error: submissionError } = await database
      .from('form_submission')
      .select('id, form_id, tenant_id, submission_data, created_member_id, created_organization_id, organization_id')
      .eq('id', submission_id)
      .eq('form_id', form.id)
      .eq('tenant_id', form.tenant_id)
      .single();
    if (submissionError || !submission) {
      console.warn('[FormSubmissionEmail] Submission does not belong to form/tenant:', submission_id);
      return res.status(404).json({ error: 'Submission not found' });
    }

    const resolveBaseUrl = dependencies.getTrustedBaseUrlForTenant
      || getTrustedBaseUrlForTenant;
    const baseUrl = await resolveBaseUrl(req, database, form.tenant_id);

    // Task #3194: force_resend deliberately bypasses the exactly-once guard
    // (admin rerun of an already-sent submission). Only authenticated tenant
    // admins of the form's own tenant may use it — getTenantIdFromSession-style
    // membership is NOT enough.
    let forceResend = false;
    if (force_resend) {
      const tenantContextModule = dependencies.tenantContextModule
        || await import('../_lib/tenantContext.js');
      const context = await tenantContextModule.getTenantContext(req);
      const isAdmin = await tenantContextModule.hasAdminAccess(context);
      if (!isAdmin || !context.tenantId || context.tenantId !== form.tenant_id) {
        return res.status(403).json({ error: 'Resending submission emails requires tenant admin access' });
      }
      forceResend = true;
    }

    const result = await submissionEmailSender({
      supabase: database,
      form,
      formValues: submission.submission_data || {},
      fields: form.fields || [],
      submissionId: submission.id,
      createdMemberId: submission.created_member_id || null,
      createdOrganizationId: submission.created_organization_id
        || submission.organization_id
        || null,
      baseUrl,
      trigger: forceResend ? 'admin-resend' : 'client',
      allowUnguarded: false,
      forceResend,
    });

    if (result.skipped) {
      return res.json({
        // Task #3194: a refused resend re-claim reports success:false —
        // don't mask it as success, the admin needs to see it failed.
        success: result.success !== false,
        skipped: true,
        ...(result.error ? { error: result.error } : {}),
        alreadyProcessed: result.alreadyProcessed || false,
        reason: result.reason,
        emails: result.emails || [],
      });
    }

    return res.json({
      success: result.success,
      emails: result.emails || [],
      ...(result.error ? { error: result.error } : {}),
    });
  } catch (error) {
    console.error('[FormSubmissionEmail] Error:', error);
    res.status(500).json({ error: 'Failed to send submission email', details: error.message });
  }
}

export default function handler(req, res) {
  return handleSendSubmissionEmail(req, res);
}
