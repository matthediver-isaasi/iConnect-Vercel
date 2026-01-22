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
          created_date,
          organization_id
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

    // Collect all organization IDs from submissions
    const orgIds = [...new Set(
      filteredSubmissions
        .map(s => s.form_submission?.organization_id)
        .filter(Boolean)
    )];

    // Fetch organization names
    let orgMap = {};
    if (orgIds.length > 0) {
      const { data: orgs } = await supabase
        .from('organization')
        .select('id, name')
        .in('id', orgIds);
      
      if (orgs) {
        orgMap = Object.fromEntries(orgs.map(o => [o.id, o.name]));
      }
    }

    // Attach organization names to submissions
    filteredSubmissions = filteredSubmissions.map(sub => {
      const orgId = sub.form_submission?.organization_id;
      if (orgId && orgMap[orgId]) {
        return {
          ...sub,
          form_submission: {
            ...sub.form_submission,
            organization: { id: orgId, name: orgMap[orgId] }
          }
        };
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
