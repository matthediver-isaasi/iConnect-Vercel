import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.DEV_SUPABASE_URL;
const supabaseKey = process.env.DEV_SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const tenantId = '21296ad6-1350-483a-a90c-1b06ece70501';

async function debugDDConfig() {
  const soFormId = 'dd04a19b-019b-4cb2-9a7f-3a77027e9857';
  const esoFormId = 'a9ec1559-495a-4705-9da9-d51517be7bb6';

  console.log('=== DD Config Comparison ===\n');

  for (const formId of [soFormId, esoFormId]) {
    const { data: form } = await supabase
      .from('form')
      .select('id, name, due_diligence_required')
      .eq('id', formId)
      .single();

    console.log('\n' + '='.repeat(60));
    console.log('FORM:', form?.name);
    console.log('due_diligence_required:', form?.due_diligence_required);

    const { data: ddConfig, error } = await supabase
      .from('form_due_diligence_config')
      .select('*')
      .eq('form_id', formId)
      .eq('tenant_id', tenantId)
      .single();

    if (error) {
      console.log('DD Config Error:', error);
      continue;
    }

    if (!ddConfig) {
      console.log('!!! NO DD CONFIG !!!');
      continue;
    }

    console.log('DD Config ID:', ddConfig.id);
    
    const stages = ddConfig.workflow_stages || [];
    console.log('\nWorkflow Stages:', stages.length);
    
    for (const stage of stages) {
      console.log(`\n  Stage: ${stage.id} (${stage.label})`);
      console.log(`    is_initial: ${stage.is_initial}`);
      console.log(`    order: ${stage.order}`);
      
      // Check both actions and stage_actions
      const actions = stage.actions;
      const stageActions = stage.stage_actions;
      
      console.log(`    actions:`, JSON.stringify(actions));
      console.log(`    stage_actions:`, JSON.stringify(stageActions));
      
      if (stageActions?.send_contracts) {
        console.log(`    >>> send_contracts: ${JSON.stringify(stageActions.send_contracts)}`);
      }
      if (actions?.send_contracts) {
        console.log(`    >>> send_contracts (from actions): ${JSON.stringify(actions.send_contracts)}`);
      }
    }

    // Find initial stage
    const initialStage = stages.find(s => s.is_initial) || stages[0];
    console.log('\n  Initial Stage:', initialStage?.id, initialStage?.label);
    console.log('    send_contracts:', JSON.stringify(initialStage?.stage_actions?.send_contracts || initialStage?.actions?.send_contracts));
  }
}

debugDDConfig().catch(console.error);
