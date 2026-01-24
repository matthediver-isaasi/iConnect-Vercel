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

    // Check if we should include archived submissions
    const includeArchived = req.query.includeArchived === 'true';

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
        archived_at,
        archived_reason,
        swapped_from_submission_id,
        swapped_to_submission_id,
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

    // By default, exclude archived submissions
    if (!includeArchived) {
      query = query.is('archived_at', null);
    }

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
    
    console.log('[DD List] Found organization IDs:', orgIds);

    // Fetch organization names (tenant-scoped for security)
    let orgMap = {};
    if (orgIds.length > 0) {
      const { data: orgs, error: orgError } = await supabase
        .from('organization')
        .select('id, name')
        .in('id', orgIds)
        .eq('tenant_id', tenantCtx.tenantId);
      
      if (orgError) {
        console.error('[DD List] Org lookup error:', orgError);
      }
      if (orgs) {
        orgMap = Object.fromEntries(orgs.map(o => [o.id, o.name]));
        console.log('[DD List] Organization map:', orgMap);
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

    // Collect all reviewed_by emails to look up member names
    const reviewerEmails = [...new Set(
      filteredSubmissions
        .map(s => s.reviewed_by)
        .filter(Boolean)
    )];

    // Fetch member names for reviewers
    let reviewerMap = {};
    if (reviewerEmails.length > 0) {
      const { data: members } = await supabase
        .from('member')
        .select('email, first_name, last_name')
        .in('email', reviewerEmails)
        .eq('tenant_id', tenantCtx.tenantId);
      
      if (members) {
        reviewerMap = Object.fromEntries(
          members.map(m => [m.email, `${m.first_name || ''} ${m.last_name || ''}`.trim() || m.email])
        );
      }
    }

    // Attach reviewer names to submissions
    filteredSubmissions = filteredSubmissions.map(sub => {
      if (sub.reviewed_by && reviewerMap[sub.reviewed_by]) {
        return {
          ...sub,
          reviewed_by_name: reviewerMap[sub.reviewed_by]
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
