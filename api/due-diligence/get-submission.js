import { supabase } from '../_lib/database.js';
import { getSessionMember } from '../_lib/session.js';
import { getTenantContext } from '../_lib/tenantContext.js';

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

    if (!id && !formSubmissionId) {
      return res.status(400).json({ error: 'id or formSubmissionId is required' });
    }

    let query = supabase
      .from('form_submission_due_diligence')
      .select(`
        *,
        form_submission:form_submission_id(
          id,
          form_id,
          form_values,
          status,
          created_date,
          member_id,
          organization_id
        )
      `)
      .eq('tenant_id', tenantCtx.tenantId);

    if (id) {
      query = query.eq('id', id);
    } else {
      query = query.eq('form_submission_id', formSubmissionId);
    }

    const { data: ddSubmission, error: ddError } = await query.single();

    if (ddError || !ddSubmission) {
      return res.status(404).json({ error: 'Due diligence submission not found' });
    }

    // Get the form's DD config with tenant isolation
    const { data: ddConfig } = await supabase
      .from('form_due_diligence_config')
      .select('*')
      .eq('form_id', ddSubmission.form_submission?.form_id)
      .eq('tenant_id', tenantCtx.tenantId)
      .single();

    // Get form details with tenant isolation
    const { data: form } = await supabase
      .from('form')
      .select('id, name, fields, is_due_diligence_enabled')
      .eq('id', ddSubmission.form_submission?.form_id)
      .eq('tenant_id', tenantCtx.tenantId)
      .single();

    return res.status(200).json({
      success: true,
      submission: ddSubmission,
      config: ddConfig,
      form: form
    });

  } catch (error) {
    console.error('[DD Get] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
