import { executeConfirmedWorkflow } from '../_lib/workflows.js';
import { getSessionMember } from '../_lib/session.js';
import { supabase } from '../_lib/database.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const sessionMember = await getSessionMember(req);
    if (!sessionMember) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { workflow_id, entity_type, entity_id, action: requestAction, revert_field_id, revert_field_type, revert_previous_value } = req.body;

    if (!workflow_id || !entity_type || !entity_id) {
      return res.status(400).json({ error: 'Missing required fields: workflow_id, entity_type, entity_id' });
    }

    if (!supabase) {
      return res.status(503).json({ error: 'Database not configured' });
    }

    const { data: workflow, error: workflowError } = await supabase
      .from('workflow')
      .select('id, tenant_id, name')
      .eq('id', workflow_id)
      .single();

    if (workflowError || !workflow) {
      return res.status(404).json({ error: 'Workflow not found' });
    }

    if (workflow.tenant_id !== sessionMember.tenant_id) {
      console.warn(`[execute-workflow] Tenant mismatch: member tenant ${sessionMember.tenant_id} vs workflow tenant ${workflow.tenant_id}`);
      return res.status(403).json({ error: 'Access denied' });
    }

    const tableName = entity_type === 'job_posting' ? 'job_posting' : entity_type;
    const { data: entity, error: entityError } = await supabase
      .from(tableName)
      .select('id, tenant_id')
      .eq('id', entity_id)
      .single();

    if (entityError || !entity) {
      return res.status(404).json({ error: 'Entity not found' });
    }

    if (entity.tenant_id !== sessionMember.tenant_id) {
      console.warn(`[execute-workflow] Entity tenant mismatch: member tenant ${sessionMember.tenant_id} vs entity tenant ${entity.tenant_id}`);
      return res.status(403).json({ error: 'Access denied' });
    }

    if (requestAction === 'revert' && revert_field_id) {
      console.log(`[execute-workflow] Reverting field ${revert_field_id} (type: ${revert_field_type}) to "${revert_previous_value}"`);
      try {
        if (revert_field_type === 'custom') {
          const prefTable = entity_type === 'organization' ? 'organization_preference_value' : 'member_preference_value';
          const idCol = entity_type === 'organization' ? 'organization_id' : 'member_id';
          const { error: revertError } = await supabase
            .from(prefTable)
            .update({ value: revert_previous_value ?? null })
            .eq(idCol, entity_id)
            .eq('field_id', revert_field_id);
          if (revertError) {
            console.error(`[execute-workflow] Revert error:`, revertError);
            return res.status(500).json({ success: false, error: 'Failed to revert field' });
          }
        } else {
          const revertTable = entity_type === 'job_posting' ? 'job_posting' : entity_type;
          const { error: revertError } = await supabase
            .from(revertTable)
            .update({ [revert_field_id]: revert_previous_value ?? null })
            .eq('id', entity_id);
          if (revertError) {
            console.error(`[execute-workflow] Revert error:`, revertError);
            return res.status(500).json({ success: false, error: 'Failed to revert field' });
          }
        }
        return res.status(200).json({ success: true, reverted: true, message: 'Field reverted to previous value' });
      } catch (err) {
        console.error(`[execute-workflow] Revert exception:`, err);
        return res.status(500).json({ success: false, error: 'Failed to revert field' });
      }
    }

    const baseUrl = `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`;
    
    const result = await executeConfirmedWorkflow(
      workflow_id,
      entity_type,
      entity_id,
      null,
      null,
      baseUrl
    );

    if (result.success) {
      return res.status(200).json({
        success: true,
        message: `Workflow "${result.workflow_name}" executed successfully`,
        action_results: result.results || [],
      });
    } else {
      return res.status(400).json({
        success: false,
        error: result.error
      });
    }
  } catch (error) {
    console.error('[execute-workflow] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
