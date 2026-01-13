import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { form_id, form_name, answers, submission_data, source, tenant } = req.body;

  if (!form_id) {
    return res.status(400).json({ error: 'Form ID is required' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    // Get tenant from query param or subdomain
    const host = req.headers['x-forwarded-host'] || req.headers.host || '';
    const subdomain = host.split('.')[0];
    const tenantIdentifier = tenant || subdomain;

    if (!tenantIdentifier || tenantIdentifier === 'www' || tenantIdentifier === 'iconn') {
      return res.status(400).json({ error: 'Invalid tenant context' });
    }

    // Get tenant ID
    let tenantResult = await supabase
      .from('tenant')
      .select('id')
      .eq('slug', tenantIdentifier)
      .eq('status', 'active')
      .single();
    
    if (tenantResult.error || !tenantResult.data) {
      tenantResult = await supabase
        .from('tenant')
        .select('id')
        .eq('subdomain', tenantIdentifier)
        .single();
    }

    const { data: tenantData, error: tenantError } = tenantResult;

    if (tenantError || !tenantData) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    // Verify the form exists and belongs to this tenant
    const { data: form, error: formError } = await supabase
      .from('form')
      .select('id, tenant_id, require_authentication, send_email, email_templates')
      .eq('id', form_id)
      .eq('tenant_id', tenantData.id)
      .eq('is_active', true)
      .single();

    if (formError || !form) {
      return res.status(404).json({ error: 'Form not found' });
    }

    // Forms that require authentication cannot be submitted publicly
    if (form.require_authentication) {
      return res.status(403).json({ error: 'This form requires authentication' });
    }

    // Create the form submission
    const submissionRecord = {
      form_id,
      form_name,
      tenant_id: tenantData.id,
      answers: answers || [],
      submission_data: submission_data || {},
      source: source || 'embed',
      status: 'pending',
      created_date: new Date().toISOString()
    };

    const { data: submission, error: insertError } = await supabase
      .from('form_submission')
      .insert(submissionRecord)
      .select()
      .single();

    if (insertError) {
      console.error('[Public Form Submission] Insert error:', insertError);
      return res.status(500).json({ error: 'Failed to save submission' });
    }

    // If form has email sending enabled, trigger email sending
    if (form.send_email && form.email_templates?.length > 0) {
      try {
        // Get form fields for email processing
        const { data: fullForm } = await supabase
          .from('form')
          .select('fields')
          .eq('id', form_id)
          .single();

        // Call email sending endpoint (fire and forget)
        fetch(`${req.headers['x-forwarded-proto'] || 'https'}://${host}/api/forms/send-submission-email`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            form_id,
            form_values: submission_data || {},
            fields: fullForm?.fields || [],
            email_templates: form.email_templates
          })
        }).catch(err => {
          console.error('[Public Form Submission] Email send failed:', err);
        });
      } catch (err) {
        console.error('[Public Form Submission] Email setup error:', err);
      }
    }

    return res.status(201).json({
      success: true,
      id: submission.id,
      message: 'Form submitted successfully'
    });
  } catch (error) {
    console.error('[Public Form Submission] Error:', error);
    return res.status(500).json({ error: 'Failed to process submission' });
  }
}
