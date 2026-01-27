import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.DEV_SUPABASE_URL;
const supabaseKey = process.env.DEV_SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const tenantId = '21296ad6-1350-483a-a90c-1b06ece70501';

async function debugStageActions() {
  const soFormId = 'dd04a19b-019b-4cb2-9a7f-3a77027e9857';

  const { data: ddConfig } = await supabase
    .from('form_due_diligence_config')
    .select('workflow_stages')
    .eq('form_id', soFormId)
    .eq('tenant_id', tenantId)
    .single();

  const stages = ddConfig?.workflow_stages || [];
  const newStage = stages.find(s => s.id === 'new');
  
  console.log('=== NEW Stage Raw Data ===\n');
  console.log('Full stage object:', JSON.stringify(newStage, null, 2));
  
  console.log('\n=== JavaScript Evaluation ===');
  console.log('newStage.actions:', newStage.actions);
  console.log('typeof newStage.actions:', typeof newStage.actions);
  console.log('newStage.stage_actions:', newStage.stage_actions);
  console.log('typeof newStage.stage_actions:', typeof newStage.stage_actions);
  
  // This is what the code does
  const stageActions = newStage.actions || newStage.stage_actions;
  console.log('\nstage.actions || stage.stage_actions:', stageActions);
  
  const sendContracts = stageActions?.send_contracts || [];
  console.log('sendContracts:', sendContracts);
  
  // Test with explicit check for properties
  console.log('\n=== Alternative evaluation ===');
  const betterStageActions = newStage.stage_actions || newStage.actions || {};
  console.log('stage_actions || actions:', betterStageActions);
  console.log('send_contracts:', betterStageActions.send_contracts);
}

debugStageActions().catch(console.error);
