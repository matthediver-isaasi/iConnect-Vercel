import { createClient } from '@supabase/supabase-js';
import { getTenantContext } from '../_lib/tenantContext.js';
import { createFormRelationshipService, FormRelationshipError } from '../_lib/formRelationshipOptions.js';
import { isResourceExcluded } from '../_lib/roleVisibility.js';
import { validateSubmissionFieldEditCandidates } from './submissionFieldEdit.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const context = await getTenantContext(req);
    if (!context.isAuthenticated || !context.tenantId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    // Create session object for compatibility
    const session = {
      tenant_id: context.tenantId,
      email: context.email || (context.memberId ? 'Member' : 'Admin')
    };

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

    // Service-role access must be preceded by a server-side entitlement check.
    // Tenant dashboard users may edit; member sessions require the same Form
    // Submissions capability that gates the administrative page.
    if (!context.tenantUserId) {
      if (!context.roleId) {
        return res.status(403).json({ error: 'Access denied' });
      }
      const { data: role, error: roleError } = await supabase
        .from('role')
        .select('excluded_features')
        .eq('id', context.roleId)
        .eq('tenant_id', context.tenantId)
        .single();
      if (roleError || !role) {
        return res.status(403).json({ error: 'Access denied' });
      }
      const exclusions = [
        ...(Array.isArray(role.excluded_features) ? role.excluded_features : []),
        ...(Array.isArray(context.memberExcludedFeatures) ? context.memberExcludedFeatures : []),
      ];
      if (isResourceExcluded(exclusions, 'page_FormSubmissions')) {
        return res.status(403).json({ error: 'Access denied' });
      }
    }

    // Get the submission to verify tenant ownership
    const { data: submission, error: fetchError } = await supabase
      .from('form_submission')
      .select('id, form_id, submission_data')
      .eq('id', submission_id)
      .eq('tenant_id', session.tenant_id)
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
      .eq('tenant_id', session.tenant_id)
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

    // Read the due-diligence original before any mutation so both independently
    // stored versions can be validated before either one is changed.
    const { data: ddRecord, error: ddError } = await supabase
      .from('form_submission_due_diligence')
      .select('id, original_form_values, history_log')
      .eq('form_submission_id', submission_id)
      .eq('tenant_id', session.tenant_id)
      .maybeSingle();

    if (ddError) {
      console.error('Failed to fetch DD record:', ddError);
      return res.status(500).json({ error: 'Failed to validate submission' });
    }

    // Validate complete effective candidates for both stores. Validation uses
    // saved field IDs (including legacy field-name fallbacks), while the
    // returned persistence candidates retain unrelated stored keys.
    let updatedSubmissionData;
    let updatedOriginalValues;
    try {
      ({
        updatedSubmissionData,
        updatedOriginalValues,
      } = await validateSubmissionFieldEditCandidates({
        relationshipService: createFormRelationshipService({
          db: supabase,
          tenantId: session.tenant_id,
        }),
        form,
        submissionData: submission.submission_data,
        originalFormValues: ddRecord?.original_form_values,
        hasDueDiligenceRecord: Boolean(ddRecord),
        fieldId: field_id,
        value,
      }));
    } catch (error) {
      if (error instanceof FormRelationshipError && error.status < 500) {
        return res.status(400).json({ error: 'Invalid relationship selection' });
      }
      console.error('[Update Submission Field] Relationship selection validation failed:', error);
      return res.status(500).json({ error: 'Failed to validate submission' });
    }

    // Update the form_submission table
    const { error: updateError } = await supabase
      .from('form_submission')
      .update({ submission_data: updatedSubmissionData })
      .eq('id', submission_id)
      .eq('tenant_id', session.tenant_id);

    if (updateError) {
      console.error('Failed to update submission:', updateError);
      return res.status(500).json({ error: 'Failed to update submission' });
    }

    if (ddRecord) {
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
