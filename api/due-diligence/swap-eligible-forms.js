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
    const { sourceSubmissionId } = req.query;

    if (!sourceSubmissionId) {
      return res.status(400).json({ error: 'sourceSubmissionId is required' });
    }

    const { data: sourceDDSubmission, error: sourceError } = await supabase
      .from('form_submission_due_diligence')
      .select(`
        id,
        form_submission_id,
        form_submission:form_submission_id(form_id)
      `)
      .eq('id', sourceSubmissionId)
      .eq('tenant_id', tenantCtx.tenantId)
      .single();

    if (sourceError || !sourceDDSubmission) {
      return res.status(404).json({ error: 'Source submission not found' });
    }

    const sourceFormId = sourceDDSubmission.form_submission?.form_id;

    const { data: ddEnabledForms, error: formsError } = await supabase
      .from('form')
      .select('id, name, fields')
      .eq('tenant_id', tenantCtx.tenantId)
      .eq('due_diligence_required', true)
      .neq('id', sourceFormId);

    if (formsError) {
      console.error('[DD Swap Eligible] Forms query error:', formsError);
      return res.status(500).json({ error: 'Failed to fetch eligible forms' });
    }

    const formIds = (ddEnabledForms || []).map(f => f.id);
    let formsWithConfigs = new Set();
    
    if (formIds.length > 0) {
      const { data: ddConfigs } = await supabase
        .from('form_due_diligence_config')
        .select('form_id')
        .eq('tenant_id', tenantCtx.tenantId)
        .in('form_id', formIds);
      
      if (ddConfigs) {
        formsWithConfigs = new Set(ddConfigs.map(c => c.form_id));
      }
    }

    const eligibleForms = (ddEnabledForms || [])
      .filter(form => formsWithConfigs.has(form.id))
      .map(form => ({
        id: form.id,
        name: form.name,
        fieldCount: (form.fields || []).length
      }));

    return res.status(200).json({
      success: true,
      sourceFormId,
      eligibleForms
    });

  } catch (error) {
    console.error('[DD Swap Eligible] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
