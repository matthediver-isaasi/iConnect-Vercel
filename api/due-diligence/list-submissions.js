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
    const { formId, status, riskLevel, limit = 50, offset = 0 } = req.query;

    let query = supabase
      .from('form_submission_due_diligence')
      .select(`
        id,
        form_submission_id,
        application_uid,
        workflow_status,
        due_diligence_score,
        risk_level,
        reviewed_by,
        reviewed_date,
        created_at,
        updated_at,
        original_form_values,
        form_submission:form_submission_id(
          id,
          form_id,
          submission_data,
          status,
          created_date
        )
      `, { count: 'exact' })
      .eq('tenant_id', tenantCtx.tenantId)
      .order('created_at', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    if (status) {
      query = query.eq('workflow_status', status);
    }

    if (riskLevel) {
      query = query.eq('risk_level', riskLevel);
    }

    const { data: submissions, error: listError, count } = await query;

    if (listError) {
      console.error('[DD List] Query error:', listError);
      return res.status(500).json({ error: 'Failed to list submissions' });
    }

    // Filter by formId if provided (need to filter after join)
    let filteredSubmissions = submissions || [];
    if (formId) {
      filteredSubmissions = filteredSubmissions.filter(
        s => s.form_submission?.form_id === formId
      );
    }

    // Get DD configs for all forms to find organization lookup fields
    const formIds = [...new Set(filteredSubmissions.map(s => s.form_submission?.form_id).filter(Boolean))];
    let ddConfigByFormId = {};
    if (formIds.length > 0) {
      const { data: ddConfigs } = await supabase
        .from('form_due_diligence_config')
        .select('form_id, applicant_organization_name_field')
        .in('form_id', formIds)
        .eq('tenant_id', tenantCtx.tenantId);
      
      if (ddConfigs) {
        ddConfigByFormId = Object.fromEntries(ddConfigs.map(c => [c.form_id, c]));
      }
    }

    // Collect organization IDs from submission data using the configured field
    const orgIdsToLookup = [];
    filteredSubmissions.forEach(sub => {
      const formId = sub.form_submission?.form_id;
      const config = ddConfigByFormId[formId];
      const orgField = config?.applicant_organization_name_field;
      if (orgField) {
        const submissionData = sub.form_submission?.submission_data || sub.original_form_values || {};
        const orgId = submissionData[orgField];
        if (orgId && typeof orgId === 'string' && orgId.match(/^[0-9a-f-]{36}$/i)) {
          orgIdsToLookup.push(orgId);
        }
      }
    });

    // Fetch organization names
    let orgMap = {};
    const uniqueOrgIds = [...new Set(orgIdsToLookup)];
    if (uniqueOrgIds.length > 0) {
      const { data: orgs } = await supabase
        .from('organization')
        .select('id, name')
        .in('id', uniqueOrgIds);
      
      if (orgs) {
        orgMap = Object.fromEntries(orgs.map(o => [o.id, o.name]));
      }
    }

    // Attach organization names to submissions
    filteredSubmissions = filteredSubmissions.map(sub => {
      const formId = sub.form_submission?.form_id;
      const config = ddConfigByFormId[formId];
      const orgField = config?.applicant_organization_name_field;
      if (orgField) {
        const submissionData = sub.form_submission?.submission_data || sub.original_form_values || {};
        const orgId = submissionData[orgField];
        if (orgId && orgMap[orgId]) {
          return {
            ...sub,
            form_submission: {
              ...sub.form_submission,
              organization: { id: orgId, name: orgMap[orgId] }
            }
          };
        }
      }
      return sub;
    });

    return res.status(200).json({
      success: true,
      submissions: filteredSubmissions,
      total: count,
      limit: parseInt(limit),
      offset: parseInt(offset)
    });

  } catch (error) {
    console.error('[DD List] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
