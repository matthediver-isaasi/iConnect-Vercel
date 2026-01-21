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

    const { workflow_id, entity_type, entity_id } = req.body;

    if (!workflow_id || !entity_type || !entity_id) {
      return res.status(400).json({ error: 'Missing required fields: workflow_id, entity_type, entity_id' });
    }

    if (!supabase) {
      return res.status(503).json({ error: 'Database not configured' });
    }

    // Verify the workflow belongs to the same tenant as the session member
    const { data: workflow, error: workflowError } = await supabase
      .from('workflow')
      .select('id, tenant_id, name')
      .eq('id', workflow_id)
      .single();

    if (workflowError || !workflow) {
      return res.status(404).json({ error: 'Workflow not found' });
    }

    // Verify tenant match - session member's tenant must match workflow's tenant
    if (workflow.tenant_id !== sessionMember.tenant_id) {
      console.warn(`[execute-workflow] Tenant mismatch: member tenant ${sessionMember.tenant_id} vs workflow tenant ${workflow.tenant_id}`);
      return res.status(403).json({ error: 'Access denied' });
    }

    // Verify the entity belongs to the same tenant
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

    const baseUrl = `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`;
    
    // Don't pass client-supplied before/after data - let the server fetch fresh data
    const result = await executeConfirmedWorkflow(
      workflow_id,
      entity_type,
      entity_id,
      null,  // before_data - not used, server fetches fresh data
      null,  // after_data - not used, server fetches fresh data
      baseUrl
    );

    if (result.success) {
      return res.status(200).json({
        success: true,
        message: `Workflow "${result.workflow_name}" executed successfully`
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
