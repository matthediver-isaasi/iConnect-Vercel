import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

const submissionId = '2cc0519c-0510-4c21-9006-3b9fbcd047d1';

async function createDDRecord() {
  // Get the form submission
  const { data: submission, error: subError } = await supabase
    .from('form_submission')
    .select('*')
    .eq('id', submissionId)
    .single();

  if (subError || !submission) {
    console.error('Submission not found:', subError);
    return;
  }

  console.log('Found submission:', submission.id);
  console.log('Form ID:', submission.form_id);
  console.log('Submission keys:', Object.keys(submission));

  // Get the form to get tenant_id
  const { data: form, error: formError } = await supabase
    .from('form')
    .select('*')
    .eq('id', submission.form_id)
    .single();

  if (formError) {
    console.error('Form error:', formError);
    return;
  }

  console.log('Form keys:', Object.keys(form));
  const tenantId = form.tenant_id;
  console.log('Tenant ID:', tenantId);

  if (!tenantId) {
    console.error('Could not determine tenant_id');
    return;
  }

  // Check if DD record already exists
  const { data: existing } = await supabase
    .from('form_submission_due_diligence')
    .select('id')
    .eq('form_submission_id', submissionId)
    .single();

  if (existing) {
    console.log('DD record already exists:', existing.id);
    return;
  }

  // Get DD config for initial status
  const { data: ddConfig } = await supabase
    .from('form_due_diligence_config')
    .select('workflow_stages')
    .eq('form_id', submission.form_id)
    .eq('tenant_id', tenantId)
    .single();

  const workflowStages = ddConfig?.workflow_stages || [];
  const initialStage = workflowStages.find(s => s.is_initial) || workflowStages[0];
  const initialStatus = initialStage?.id || 'new';

  console.log('Initial status:', initialStatus);

  // Create the DD record
  const ddRecord = {
    form_submission_id: submission.id,
    tenant_id: tenantId,
    application_uid: `DD-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    original_form_values: submission.submission_data || {},
    reviewed_form_values: submission.submission_data || {},
    field_review_status: {},
    workflow_status: initialStatus,
    history_log: [{
      timestamp: new Date().toISOString(),
      event_type: 'manual_entry',
      user_email: 'Admin',
      details: {
        form_submission_id: submission.id,
        initial_status: initialStatus,
        note: 'Retroactively created DD record for existing submission'
      }
    }]
  };

  const { data: newRecord, error: insertError } = await supabase
    .from('form_submission_due_diligence')
    .insert(ddRecord)
    .select('id')
    .single();

  if (insertError) {
    console.error('Failed to create DD record:', insertError);
  } else {
    console.log('Created DD record:', newRecord.id);
  }
}

createDDRecord();
