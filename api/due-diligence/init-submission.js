import { supabase } from '../_lib/database.js';
import { getSessionMember } from '../_lib/session.js';
import { getTenantContext } from '../_lib/tenantContext.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const member = await getSessionMember(req);
  if (!member) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const tenantCtx = await getTenantContext(req);
  if (!tenantCtx.tenantId) {
    return res.status(403).json({ error: 'Tenant context required' });
  }

  try {
    const { formSubmissionId } = req.body;

    if (!formSubmissionId) {
      return res.status(400).json({ error: 'formSubmissionId is required' });
    }

    // Check if DD record already exists (with tenant isolation)
    const { data: existing } = await supabase
      .from('form_submission_due_diligence')
      .select('id')
      .eq('form_submission_id', formSubmissionId)
      .eq('tenant_id', tenantCtx.tenantId)
      .single();

    if (existing) {
      return res.status(200).json({
        success: true,
        id: existing.id,
        message: 'Due diligence record already exists'
      });
    }

    // Get the form submission with tenant isolation
    const { data: formSubmission, error: subError } = await supabase
      .from('form_submission')
      .select('*, form:form_id(id, due_diligence_required)')
      .eq('id', formSubmissionId)
      .eq('tenant_id', tenantCtx.tenantId)
      .single();

    if (subError || !formSubmission) {
      return res.status(404).json({ error: 'Form submission not found' });
    }

    // Get the form's DD config with tenant isolation
    const { data: ddConfig } = await supabase
      .from('form_due_diligence_config')
      .select('workflow_stages')
      .eq('form_id', formSubmission.form_id)
      .eq('tenant_id', tenantCtx.tenantId)
      .single();

    // Find initial stage
    const workflowStages = ddConfig?.workflow_stages || [];
    const initialStage = workflowStages.find(s => s.is_initial) || workflowStages[0];
    const initialStatus = initialStage?.id || 'new';

    // Create the DD submission record
    const ddRecord = {
      form_submission_id: formSubmissionId,
      tenant_id: tenantCtx.tenantId,
      application_uid: `DD-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      original_form_values: formSubmission.form_values || {},
      reviewed_form_values: formSubmission.form_values || {},
      field_review_status: {},
      workflow_status: initialStatus,
      history_log: [{
        timestamp: new Date().toISOString(),
        event_type: 'submission_received',
        user_email: 'System',
        details: {
          form_submission_id: formSubmissionId,
          initial_status: initialStatus
        }
      }]
    };

    const { data: newRecord, error: insertError } = await supabase
      .from('form_submission_due_diligence')
      .insert(ddRecord)
      .select()
      .single();

    if (insertError) {
      console.error('[DD Init] Insert error:', insertError);
      return res.status(500).json({ error: 'Failed to create due diligence record' });
    }

    return res.status(201).json({
      success: true,
      id: newRecord.id,
      message: 'Due diligence record created'
    });

  } catch (error) {
    console.error('[DD Init] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
