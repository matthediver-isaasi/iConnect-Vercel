import { supabase } from '../_lib/database.js';
import { getSessionMember } from '../_lib/session.js';
import { getTenantContext } from '../_lib/tenantContext.js';

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
    const { stageId, formId } = req.body;

    if (!stageId || !formId) {
      return res.status(400).json({ error: 'stageId and formId are required' });
    }

    const result = {
      has_meeting_actions: false,
      meeting_actions: [],
      requires_agent_selection: false
    };

    const { data: meetingRequests, error: mrError } = await supabase
      .from('stage_meeting_request')
      .select(`
        id,
        meeting_template:meeting_template_id (
          id, name, slug, duration_minutes
        )
      `)
      .eq('due_diligence_stage_id', stageId)
      .eq('tenant_id', tenantCtx.tenantId)
      .eq('is_active', true)
      .order('sort_order', { ascending: true });

    if (mrError || !meetingRequests || meetingRequests.length === 0) {
      return res.status(200).json(result);
    }

    result.has_meeting_actions = true;

    for (const mr of meetingRequests) {
      const template = mr.meeting_template;
      if (!template) continue;

      const { data: agentAssignments } = await supabase
        .from('agent_meeting_template')
        .select('identity_id')
        .eq('meeting_template_id', template.id)
        .eq('tenant_id', tenantCtx.tenantId);

      if (!agentAssignments || agentAssignments.length === 0) continue;

      const agentDetails = [];
      for (const assignment of agentAssignments) {
        const { data: agentMembership } = await supabase
          .from('tenant_membership')
          .select('booking_slug, identity:identity_id(id, first_name, last_name, email)')
          .eq('identity_id', assignment.identity_id)
          .eq('tenant_id', tenantCtx.tenantId)
          .single();

        if (agentMembership?.booking_slug && agentMembership.identity) {
          agentDetails.push({
            identity_id: agentMembership.identity.id,
            name: [agentMembership.identity.first_name, agentMembership.identity.last_name].filter(Boolean).join(' '),
            email: agentMembership.identity.email,
            booking_slug: agentMembership.booking_slug
          });
        }
      }

      if (agentDetails.length > 0) {
        result.meeting_actions.push({
          meeting_request_id: mr.id,
          template_id: template.id,
          template_name: template.name,
          agents: agentDetails
        });
      }
    }

    // Calculate total unique agents across all meeting actions
    const allUniqueAgents = new Set();
    result.meeting_actions.forEach(action => {
      action.agents.forEach(agent => allUniqueAgents.add(agent.identity_id));
    });
    
    // Only require agent selection if there are multiple distinct agents
    result.requires_agent_selection = allUniqueAgents.size > 1;

    return res.status(200).json(result);
  } catch (error) {
    console.error('[DD Check Stage Actions] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
