import { supabase } from '../_lib/database.js';
import { getSessionMember } from '../_lib/session.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import { createFormRelationshipService, FormRelationshipError } from '../_lib/formRelationshipOptions.js';
import { initializeFormDueDiligence } from '../_lib/formDueDiligence.js';

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
      .select('id, form_id, tenant_id, submission_data')
      .eq('id', formSubmissionId)
      .eq('tenant_id', tenantCtx.tenantId)
      .single();

    if (subError || !formSubmission) {
      return res.status(404).json({ error: 'Form submission not found' });
    }

    const { data: form, error: formError } = await supabase
      .from('form')
      .select('id, tenant_id, fields, due_diligence_required')
      .eq('id', formSubmission.form_id)
      .eq('tenant_id', tenantCtx.tenantId)
      .single();
    if (formError || !form) {
      return res.status(404).json({ error: 'Form not found' });
    }

    const submissionValues = formSubmission.submission_data || {};
    try {
      await createFormRelationshipService({
        db: supabase,
        tenantId: tenantCtx.tenantId,
      }).validateSubmission({ form, submissionData: submissionValues });
    } catch (error) {
      if (error instanceof FormRelationshipError && error.status < 500) {
        return res.status(400).json({ error: 'Invalid relationship selection' });
      }
      console.error('[DD Init] Relationship selection validation failed:', error);
      return res.status(500).json({ error: 'Failed to validate submission' });
    }

    const initialization = await initializeFormDueDiligence({
      db: supabase,
      submissionId: formSubmissionId,
      tenantId: tenantCtx.tenantId,
    });
    if (!initialization.ok) {
      console.error('[DD Init] Durable initialization failed:', initialization.error || initialization.code);
      return res.status(500).json({ error: 'Failed to initialize due diligence record' });
    }
    if (!initialization.claimed) {
      if (initialization.code === 'ALREADY_COMPLETED') {
        const { data: completedRecord } = await supabase
          .from('form_submission_due_diligence')
          .select('id')
          .eq('form_submission_id', formSubmissionId)
          .eq('tenant_id', tenantCtx.tenantId)
          .maybeSingle();
        if (completedRecord) {
          return res.status(200).json({
            success: true,
            id: completedRecord.id,
            message: 'Due diligence record already exists',
          });
        }
      }
      if (['FORM_NOT_ELIGIBLE', 'ANONYMOUS_SUBMISSION', 'NOT_PROSPECTIVELY_MARKED',
        'PAYMENT_NOT_SUCCESSFUL', 'PAYMENT_LIFECYCLE_REQUIRES_MARKER'].includes(initialization.code)) {
        return res.status(400).json({ error: 'Submission is not eligible for due diligence', code: initialization.code });
      }
      return res.status(409).json({
        error: 'Due diligence initialization is already in progress or requires attention',
        code: initialization.code,
      });
    }

    return res.status(201).json({
      success: true,
      id: initialization.ddRecordId,
      message: 'Due diligence record created',
      stage_actions_results: initialization.stageActionsResults || []
    });

  } catch (error) {
    console.error('[DD Init] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
