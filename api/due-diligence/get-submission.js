import { supabase } from '../_lib/database.js';
import { getSessionMember } from '../_lib/session.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import {
  attachDueDiligenceReferences,
  getDueDiligenceReferenceProjection,
  resolveDueDiligenceSubmissionReferences,
} from './submissionReferences.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
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
    const { id, formSubmissionId } = req.query;

    console.log('[DD Get] Request params:', { id, formSubmissionId, tenantId: tenantCtx.tenantId });

    if (!id && !formSubmissionId) {
      return res.status(400).json({ error: 'id or formSubmissionId is required' });
    }

    let query = supabase
      .from('form_submission_due_diligence')
      .select(`
        *,
         form_submission:form_submission_id!inner(
          id,
          form_id,
           tenant_id,
          submission_data,
          status,
          created_date,
           organization_id,
           created_member_id,
           created_organization_id
        )
      `)
       .eq('tenant_id', tenantCtx.tenantId)
       .eq('form_submission.tenant_id', tenantCtx.tenantId);

    if (id) {
      query = query.eq('id', id);
    } else {
      query = query.eq('form_submission_id', formSubmissionId);
    }

    const { data: ddSubmission, error: ddError } = await query.single();

    console.log('[DD Get] Query result:', { found: !!ddSubmission, error: ddError?.message, ddSubmissionId: ddSubmission?.id });

    if (ddError || !ddSubmission) {
      console.log('[DD Get] Not found - ddError:', ddError, 'ddSubmission:', ddSubmission);
      return res.status(404).json({ error: 'Due diligence submission not found' });
    }

    // Get the form's DD config with tenant isolation
    const { data: ddConfig } = await supabase
      .from('form_due_diligence_config')
      .select('*')
      .eq('form_id', ddSubmission.form_submission?.form_id)
      .eq('tenant_id', tenantCtx.tenantId)
      .single();

    // Get form details with tenant isolation (include pages for multi-step forms)
    const { data: form } = await supabase
      .from('form')
      .select('id, name, slug, fields, pages, due_diligence_required, application_level')
      .eq('id', ddSubmission.form_submission?.form_id)
      .eq('tenant_id', tenantCtx.tenantId)
      .single();

    // Resolve member and organisation references independently.  This keeps a
    // member UUID out of the organisation lookup and gives member-based DD
    // submissions a stable human-readable header even when both entities are
    // present.
    const references = await resolveDueDiligenceSubmissionReferences({
      db: supabase,
      tenantId: tenantCtx.tenantId,
      formSubmissions: [ddSubmission.form_submission],
    });
    const enrichedFormSubmission = attachDueDiligenceReferences(
      ddSubmission.form_submission,
      references,
    );
    const reference = references[String(ddSubmission.form_submission?.id || '')] || {};

    // Look up reviewer name if there's a reviewed_by email
    let reviewerName = null;
    if (ddSubmission.reviewed_by) {
      const { data: reviewer } = await supabase
        .from('member')
        .select('first_name, last_name')
        .eq('email', ddSubmission.reviewed_by)
        .eq('tenant_id', tenantCtx.tenantId)
        .single();
      
      if (reviewer) {
        reviewerName = [reviewer.first_name, reviewer.last_name].filter(Boolean).join(' ') || null;
      }
    }

    return res.status(200).json({
      success: true,
      submission: {
        ...ddSubmission,
        application_level: form?.application_level || 'member',
        ...getDueDiligenceReferenceProjection(ddSubmission.form_submission, references, {
          applicationLevel: form?.application_level || 'member',
          cardReferenceField: ddConfig?.card_reference_field || null,
          applicationUid: ddSubmission.application_uid,
          formValues: ddSubmission.original_form_values
            || ddSubmission.form_submission?.submission_data
            || {},
        }),
        form_submission: enrichedFormSubmission,
        reviewed_by_name: reviewerName
      },
      config: ddConfig,
      form: form,
      member: reference.member || null,
      organization: reference.organization || null,
      member_reference_id: reference.memberId || null,
      organization_reference_id: reference.organizationId || null,
    });

  } catch (error) {
    console.error('[DD Get] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
