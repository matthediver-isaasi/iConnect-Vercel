import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const tenantContext = await getTenantContext(req);
    if (!tenantContext || !tenantContext.isAuthenticated) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const tenantId = tenantContext.tenantId;
    if (!tenantId) {
      return res.status(400).json({ error: 'Tenant context required' });
    }

    const { formSubmissionId } = req.query;
    if (!formSubmissionId) {
      return res.status(400).json({ error: 'formSubmissionId is required' });
    }

    const { data: requests, error } = await supabase
      .from('dd_meeting_request')
      .select(`
        *,
        meeting_template:meeting_template_id (
          id, name, slug, duration_minutes, meeting_type
        ),
        agent:agent_identity_id (
          id, first_name, last_name, email
        ),
        booking:agent_booking_id (
          id, starts_at, ends_at, status
        )
      `)
      .eq('form_submission_id', formSubmissionId)
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: true });

    if (error) {
      console.error('[DD Meeting Requests] Error fetching requests:', error);
      return res.status(500).json({ error: 'Failed to fetch meeting requests' });
    }

    return res.status(200).json({ requests: requests || [] });
  } catch (error) {
    console.error('[DD Meeting Requests] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
