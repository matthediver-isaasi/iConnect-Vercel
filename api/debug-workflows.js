import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

const supabase = supabaseUrl && supabaseServiceKey 
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (!supabase) {
    return res.status(500).json({ error: 'Supabase not configured' });
  }

  try {
    // Get all active workflows
    const { data: workflows, error: wfError } = await supabase
      .from('workflow')
      .select('*')
      .eq('is_active', true);

    // Get recent workflow logs
    const { data: logs, error: logError } = await supabase
      .from('workflow_log')
      .select('*')
      .order('executed_at', { ascending: false })
      .limit(10);

    // Get recent preference value updates
    const { data: prefValues, error: pvError } = await supabase
      .from('organization_preference_value')
      .select('*')
      .order('id', { ascending: false })
      .limit(5);

    // Get a specific preference value by ID to check its structure
    const testPrefId = req.query.pref_id;
    let prefValueDetails = null;
    if (testPrefId) {
      const { data: pv, error: pvErr } = await supabase
        .from('organization_preference_value')
        .select('*')
        .eq('id', testPrefId)
        .single();
      prefValueDetails = { data: pv, error: pvErr?.message };
    }
    
    // Simulate a PATCH update and see what data is returned
    const simulatePatchId = req.query.simulate_patch_id;
    let patchSimulation = null;
    if (simulatePatchId) {
      // This simulates what happens when we update and select
      const { data: beforeData } = await supabase
        .from('organization_preference_value')
        .select('*')
        .eq('id', simulatePatchId)
        .single();
        
      patchSimulation = {
        id: simulatePatchId,
        before_data: beforeData,
        has_field_id: !!beforeData?.field_id,
        has_organization_id: !!beforeData?.organization_id,
        field_id: beforeData?.field_id,
        organization_id: beforeData?.organization_id,
        value: beforeData?.value
      };
    }

    // Test a specific workflow trigger manually
    // Note: DB column is 'field_id' (not preference_field_id)
    const testFieldId = req.query.field_id;
    const testValue = req.query.value;
    const testEntityId = req.query.entity_id;
    
    let testResult = null;
    if (testFieldId && testValue && testEntityId) {
      // Find matching workflows
      const matchingWorkflows = (workflows || []).filter(wf => {
        const cfg = wf.trigger_config;
        if (!cfg || cfg.field_type !== 'custom' || cfg.field_id !== testFieldId) return false;
        
        const target = String(cfg.value ?? '').toLowerCase();
        const actual = String(testValue ?? '').toLowerCase();
        
        if (cfg.operator === 'equals' || cfg.operator === 'changed_to') {
          return actual === target;
        }
        return false;
      });

      testResult = {
        field_id: testFieldId,
        value: testValue,
        entity_id: testEntityId,
        matching_workflows: matchingWorkflows.map(w => ({
          id: w.id,
          name: w.name,
          trigger_config: w.trigger_config
        }))
      };

      // Actually trigger the workflow if requested
      if (req.query.execute === 'true' && matchingWorkflows.length > 0) {
        for (const workflow of matchingWorkflows) {
          const results = [];
          for (const action of (workflow.actions || [])) {
            if (action.type === 'update_field' && action.config?.field_type === 'core') {
              const table = 'organization';
              await supabase.from(table).update({ [action.config.field_id]: action.config.value }).eq('id', testEntityId);
              results.push({ action_type: 'update_field', status: 'success' });
            }
          }

          await supabase.from('workflow_log').insert({
            workflow_id: workflow.id,
            entity_type: 'organization',
            entity_id: testEntityId,
            trigger_data: { field_id: testFieldId, value: testValue, trigger_type: 'manual_test' },
            actions_executed: results,
            status: 'success'
          });
          
          testResult.executed = true;
        }
      }
    }

    return res.json({
      supabase_connected: true,
      workflows: workflows || [],
      workflow_error: wfError?.message,
      recent_logs: logs || [],
      log_error: logError?.message,
      recent_preference_values: prefValues || [],
      pv_error: pvError?.message,
      pref_value_details: prefValueDetails,
      patch_simulation: patchSimulation,
      test_result: testResult
    });
  } catch (error) {
    return res.status(500).json({ error: error.message, stack: error.stack });
  }
}
