import { supabase } from '../_lib/database.js';
import { getSessionTenantUser } from '../_lib/session.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const tenantUser = await getSessionTenantUser(req);
    if (!tenantUser) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const tenantId = tenantUser._sessionTenantId || tenantUser.tenant_id;
    if (!tenantId) {
      return res.status(400).json({ error: 'Tenant context required' });
    }

    const { formId } = req.query;
    if (!formId) {
      return res.status(400).json({ error: 'formId is required' });
    }

    const { data: ddStages, error: stagesError } = await supabase
      .from('due_diligence_stage')
      .select('id, stage_key, name, color')
      .eq('tenant_id', tenantId)
      .eq('form_id', formId)
      .order('display_order', { ascending: true });

    if (stagesError) {
      console.error('[DD Configured Meetings] Error fetching stages:', stagesError);
      return res.status(500).json({ error: 'Failed to fetch stages' });
    }

    if (!ddStages || ddStages.length === 0) {
      return res.status(200).json({ configured_meetings: [] });
    }

    const stageIds = ddStages.map(s => s.id);
    const { data: meetingConfigs, error: configsError } = await supabase
      .from('stage_meeting_request')
      .select(`
        id,
        due_diligence_stage_id,
        is_active,
        recipient_email_field,
        recipient_name_field,
        meeting_template:meeting_template_id (
          id, name, slug, duration_minutes, meeting_type
        )
      `)
      .eq('tenant_id', tenantId)
      .in('due_diligence_stage_id', stageIds)
      .eq('is_active', true);

    if (configsError) {
      console.error('[DD Configured Meetings] Error fetching meeting configs:', configsError);
      return res.status(500).json({ error: 'Failed to fetch meeting configurations' });
    }

    if (!meetingConfigs || meetingConfigs.length === 0) {
      return res.status(200).json({ configured_meetings: [] });
    }

    const templateIds = [...new Set(meetingConfigs.map(c => c.meeting_template?.id).filter(Boolean))];
    
    let agentAssignments = [];
    if (templateIds.length > 0) {
      const { data: assignments, error: assignError } = await supabase
        .from('agent_meeting_template')
        .select(`
          meeting_template_id,
          identity:identity_id (
            id, first_name, last_name, email, booking_slug
          )
        `)
        .in('meeting_template_id', templateIds)
        .eq('is_active', true);

      if (!assignError) {
        agentAssignments = assignments || [];
      }
    }

    const result = meetingConfigs.map(config => {
      const stage = ddStages.find(s => s.id === config.due_diligence_stage_id);
      const agents = agentAssignments
        .filter(a => a.meeting_template_id === config.meeting_template?.id)
        .map(a => a.identity)
        .filter(Boolean);

      return {
        config_id: config.id,
        stage_id: config.due_diligence_stage_id,
        stage_name: stage?.name || 'Unknown Stage',
        stage_key: stage?.stage_key || null,
        stage_color: stage?.color || null,
        meeting_template: config.meeting_template,
        agents: agents,
        recipient_email_field: config.recipient_email_field,
        recipient_name_field: config.recipient_name_field
      };
    });

    return res.status(200).json({ configured_meetings: result });
  } catch (error) {
    console.error('[DD Configured Meetings] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
