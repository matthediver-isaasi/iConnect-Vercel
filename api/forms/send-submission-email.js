import { createClient } from '@supabase/supabase-js';
import { sendSubmissionEmailsGuarded } from '../_lib/formSubmissionEmails.js';

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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  try {
    console.log('[FormSubmissionEmail] === ENDPOINT CALLED ===');

    const {
      form_id,
      submission_id,
      form_values,
      fields,
      created_member_id,       // Member ID from process-application
      created_organization_id, // Organization ID from process-application
      _debug_form_email_config
    } = req.body;

    console.log('[FormSubmissionEmail] Request received for form:', form_id, 'submission:', submission_id);
    if (_debug_form_email_config) {
      console.log('[FormSubmissionEmail] CLIENT-SIDE form email config:', JSON.stringify(_debug_form_email_config));
    }

    if (!form_id) {
      return res.status(400).json({ error: 'form_id is required' });
    }

    // Get the form with email settings
    const { data: form, error: formError } = await supabase
      .from('form')
      .select('*, tenant_id')
      .eq('id', form_id)
      .single();

    if (formError || !form) {
      console.log('[FormSubmissionEmail] Form not found:', form_id, formError);
      return res.status(404).json({ error: 'Form not found' });
    }

    // Derive base URL for {{set_password_url}} placeholder
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    let host = req.headers['x-forwarded-host'] || req.headers.host || '';
    if (!host && process.env.VERCEL_URL) {
      host = process.env.VERCEL_URL;
    }
    const baseUrl = host ? `${protocol}://${host}` : (process.env.APP_URL || '');

    const result = await sendSubmissionEmailsGuarded({
      supabase,
      form,
      formValues: form_values,
      fields,
      submissionId: submission_id || null,
      createdMemberId: created_member_id || null,
      createdOrganizationId: created_organization_id || null,
      baseUrl,
      trigger: 'client',
      // When submission_id is missing there is nothing to claim against;
      // preserve the legacy unguarded behaviour for such callers.
      allowUnguarded: true,
    });

    if (result.skipped) {
      return res.json({
        success: true,
        skipped: true,
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
