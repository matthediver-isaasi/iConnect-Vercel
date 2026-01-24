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
    
    console.log('[DD Check Stage Actions] ========== START ==========');
    console.log('[DD Check Stage Actions] Input:', { stageId, formId, tenantId: tenantCtx.tenantId });

    if (!stageId || !formId) {
      console.log('[DD Check Stage Actions] Missing required params');
      return res.status(400).json({ error: 'stageId and formId are required' });
    }

    const result = {
      has_meeting_actions: false,
      meeting_actions: [],
      requires_agent_selection: false,
      has_email_actions: false,
      email_actions: [],
      requires_custom_message: false
    };

    // Query stage_meeting_request for this stage
    console.log('[DD Check Stage Actions] Querying stage_meeting_request for stageId:', stageId);
    const { data: meetingRequests, error: mrError } = await supabase
      .from('stage_meeting_request')
      .select(`
        id,
        due_diligence_stage_id,
        is_active,
        meeting_template:meeting_template_id (
          id, name, slug, duration_minutes
        )
      `)
      .eq('due_diligence_stage_id', stageId)
      .eq('tenant_id', tenantCtx.tenantId)
      .eq('is_active', true)
      .order('sort_order', { ascending: true });

    console.log('[DD Check Stage Actions] stage_meeting_request query result:', {
      error: mrError,
      count: meetingRequests?.length || 0,
      data: meetingRequests
    });

    if (mrError) {
      console.log('[DD Check Stage Actions] Query error:', mrError);
      return res.status(200).json(result);
    }
    
    if (!meetingRequests || meetingRequests.length === 0) {
      console.log('[DD Check Stage Actions] No active meeting requests found for this stage');
      
      // Debug: Check if there are ANY stage_meeting_request records for this tenant
      const { data: allMRs } = await supabase
        .from('stage_meeting_request')
        .select('id, due_diligence_stage_id, is_active, tenant_id')
        .eq('tenant_id', tenantCtx.tenantId);
      console.log('[DD Check Stage Actions] All stage_meeting_requests for tenant:', allMRs);
      
      return res.status(200).json(result);
    }

    result.has_meeting_actions = true;
    console.log('[DD Check Stage Actions] Found', meetingRequests.length, 'meeting request configs');
    
    // Detailed debug for each step
    const debugSteps = [];

    for (const mr of meetingRequests) {
      const template = mr.meeting_template;
      const stepDebug = {
        meeting_request_id: mr.id,
        template_id: template?.id,
        template_name: template?.name,
        agent_assignments: [],
        agent_memberships: [],
        agents_added: 0
      };
      
      console.log('[DD Check Stage Actions] Processing meeting request:', { id: mr.id, template });
      
      if (!template) {
        console.log('[DD Check Stage Actions] No template for meeting request', mr.id);
        stepDebug.error = 'No template linked';
        debugSteps.push(stepDebug);
        continue;
      }

      // Query agent assignments for this template
      console.log('[DD Check Stage Actions] Querying agent_meeting_template for template:', template.id);
      const { data: agentAssignments, error: agentError } = await supabase
        .from('agent_meeting_template')
        .select('identity_id')
        .eq('meeting_template_id', template.id)
        .eq('tenant_id', tenantCtx.tenantId);

      stepDebug.agent_assignments = agentAssignments || [];
      stepDebug.agent_assignment_error = agentError?.message;

      console.log('[DD Check Stage Actions] agent_meeting_template result:', {
        error: agentError,
        count: agentAssignments?.length || 0,
        data: agentAssignments
      });

      if (!agentAssignments || agentAssignments.length === 0) {
        console.log('[DD Check Stage Actions] No agent assignments for template', template.id);
        stepDebug.error = 'No agent assignments found';
        debugSteps.push(stepDebug);
        continue;
      }

      const agentDetails = [];
      for (const assignment of agentAssignments) {
        console.log('[DD Check Stage Actions] Looking up agent membership for identity:', assignment.identity_id);
        // Note: booking_slug is on tenant_identity, not tenant_membership
        const { data: agentMembership, error: membershipError } = await supabase
          .from('tenant_membership')
          .select('identity:identity_id(id, first_name, last_name, email, booking_slug)')
          .eq('identity_id', assignment.identity_id)
          .eq('tenant_id', tenantCtx.tenantId)
          .single();

        const identity = agentMembership?.identity;
        stepDebug.agent_memberships.push({
          identity_id: assignment.identity_id,
          found: !!agentMembership,
          booking_slug: identity?.booking_slug || null,
          has_identity: !!identity,
          error: membershipError?.message
        });

        console.log('[DD Check Stage Actions] Agent membership result:', {
          error: membershipError,
          data: agentMembership,
          hasBookingSlug: !!identity?.booking_slug,
          hasIdentity: !!identity
        });

        if (identity?.booking_slug && identity) {
          agentDetails.push({
            identity_id: identity.id,
            name: [identity.first_name, identity.last_name].filter(Boolean).join(' '),
            email: identity.email,
            booking_slug: identity.booking_slug
          });
          stepDebug.agents_added++;
        } else {
          console.log('[DD Check Stage Actions] Agent skipped - missing booking_slug or identity');
        }
      }
      
      debugSteps.push(stepDebug);

      console.log('[DD Check Stage Actions] Agent details collected:', agentDetails.length);

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
    
    console.log('[DD Check Stage Actions] Unique agents count:', allUniqueAgents.size);
    console.log('[DD Check Stage Actions] Unique agent IDs:', Array.from(allUniqueAgents));
    
    // Always require agent selection when there are meeting actions (even with 1 agent for better UX)
    result.requires_agent_selection = allUniqueAgents.size >= 1;

    // Check for email actions that require custom message prompt
    console.log('[DD Check Stage Actions] Querying stage_email_action for stageId:', stageId);
    const { data: emailActions, error: eaError } = await supabase
      .from('stage_email_action')
      .select(`
        id,
        due_diligence_stage_id,
        is_active,
        prompt_custom_message,
        email_template:email_template_id (
          id, name, subject
        )
      `)
      .eq('due_diligence_stage_id', stageId)
      .eq('tenant_id', tenantCtx.tenantId)
      .eq('is_active', true)
      .order('sort_order', { ascending: true });

    if (!eaError && emailActions && emailActions.length > 0) {
      result.has_email_actions = true;
      result.email_actions = emailActions.map(ea => ({
        id: ea.id,
        template_id: ea.email_template?.id,
        template_name: ea.email_template?.name,
        prompt_custom_message: ea.prompt_custom_message || false
      }));
      
      // Check if any email action requires custom message prompt
      result.requires_custom_message = emailActions.some(ea => ea.prompt_custom_message === true);
      console.log('[DD Check Stage Actions] Email actions found:', emailActions.length, 'requires_custom_message:', result.requires_custom_message);
    }

    console.log('[DD Check Stage Actions] Final result:', JSON.stringify(result, null, 2));
    console.log('[DD Check Stage Actions] ========== END ==========');

    // Include debug info in response for troubleshooting
    result._debug = {
      input: { stageId, formId, tenantId: tenantCtx.tenantId },
      stage_meeting_requests_found: meetingRequests?.length || 0,
      stage_meeting_requests_data: meetingRequests?.map(mr => ({
        id: mr.id,
        due_diligence_stage_id: mr.due_diligence_stage_id,
        is_active: mr.is_active,
        template: mr.meeting_template
      })) || [],
      unique_agents_count: allUniqueAgents.size,
      processing_steps: debugSteps
    };

    return res.status(200).json(result);
  } catch (error) {
    console.error('[DD Check Stage Actions] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
