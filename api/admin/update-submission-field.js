import { createClient } from '@supabase/supabase-js';
import { getSessionTenantUser } from '../_lib/session.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const session = await getSessionTenantUser(req);
    if (!session) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { submission_id, field_id, value } = req.body;

    if (!submission_id || !field_id) {
      return res.status(400).json({ error: 'Missing required fields: submission_id, field_id' });
    }

    const supabaseUrl = process.env.DEV_SUPABASE_URL || process.env.SUPABASE_URL;
    const supabaseServiceKey = process.env.DEV_SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_KEY;

    if (!supabaseUrl || !supabaseServiceKey) {
      console.error('Missing Supabase configuration');
      return res.status(500).json({ error: 'Server configuration error' });
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Get the submission to verify tenant ownership
    const { data: submission, error: fetchError } = await supabase
      .from('form_submission')
      .select('id, form_id, submission_data')
      .eq('id', submission_id)
      .single();

    if (fetchError || !submission) {
      console.error('Submission not found:', fetchError);
      return res.status(404).json({ error: 'Submission not found' });
    }

    // Get the form to verify tenant ownership and validate field
    const { data: form, error: formError } = await supabase
      .from('form')
      .select('id, tenant_id, fields')
      .eq('id', submission.form_id)
      .single();

    if (formError || !form) {
      console.error('Form not found:', formError);
      return res.status(404).json({ error: 'Form not found' });
    }

    // Verify tenant ownership
    if (form.tenant_id !== session.tenant_id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Validate that field_id exists in the form and is editable
    const fields = form.fields || [];
    const field = fields.find(f => f.id === field_id);
    
    if (!field) {
      return res.status(400).json({ error: 'Field not found in form' });
    }

    // Block editing of non-editable field types
    const nonEditableTypes = ['instructions', 'page_break', 'signature'];
    if (nonEditableTypes.includes(field.type)) {
      return res.status(400).json({ error: `Field type "${field.type}" cannot be edited` });
    }

    // Update submission_data with the new field value
    const updatedSubmissionData = {
      ...submission.submission_data,
      [field_id]: value
    };

    // Update the form_submission table
    const { error: updateError } = await supabase
      .from('form_submission')
      .update({ submission_data: updatedSubmissionData })
      .eq('id', submission_id);

    if (updateError) {
      console.error('Failed to update submission:', updateError);
      return res.status(500).json({ error: 'Failed to update submission' });
    }

    // Check if there's a due diligence record for this submission
    const { data: ddRecord, error: ddError } = await supabase
      .from('form_submission_due_diligence')
      .select('id, original_form_values, history_log')
      .eq('form_submission_id', submission_id)
      .single();

    if (ddRecord && !ddError) {
      // Update the original_form_values in the DD record
      const updatedOriginalValues = {
        ...ddRecord.original_form_values,
        [field_id]: value
      };

      // Add history entry
      const historyLog = ddRecord.history_log || [];
      historyLog.push({
        timestamp: new Date().toISOString(),
        event_type: 'field_edited',
        user_email: session.email || 'Admin',
        details: {
          field_id: field_id,
          action: 'original_value_updated',
          note: 'Field value updated via submission editor'
        }
      });

      const { error: ddUpdateError } = await supabase
        .from('form_submission_due_diligence')
        .update({ 
          original_form_values: updatedOriginalValues,
          history_log: historyLog
        })
        .eq('id', ddRecord.id);

      if (ddUpdateError) {
        console.error('Failed to update DD record:', ddUpdateError);
        // Don't fail the request, the main submission was updated
      }
    }

    return res.status(200).json({ 
      success: true, 
      message: 'Field updated successfully',
      dd_updated: !!ddRecord
    });

  } catch (error) {
    console.error('Error updating submission field:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
