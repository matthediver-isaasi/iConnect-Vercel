import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.DEV_SUPABASE_URL;
const supabaseKey = process.env.DEV_SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const tenantId = '21296ad6-1350-483a-a90c-1b06ece70501';

async function testExecution() {
  // This is the SO form submission from the logs
  const soSubmissionId = 'b0516b96-edb5-4619-9906-b13a5ff2010d';
  const soFormId = 'dd04a19b-019b-4cb2-9a7f-3a77027e9857';
  const soDDRecordId = '6ec407d8-2847-429d-a286-c261b9662ab4';

  console.log('=== Testing Stage Actions Execution for SO Form ===\n');

  // Get the DD record
  const { data: ddRecord, error: ddError } = await supabase
    .from('form_submission_due_diligence')
    .select('*')
    .eq('id', soDDRecordId)
    .single();

  if (ddError) {
    console.error('Error fetching DD record:', ddError);
    return;
  }

  console.log('DD Record workflow_status:', ddRecord.workflow_status);

  // Get form submission
  const { data: formSubmission } = await supabase
    .from('form_submission')
    .select('id, form_id')
    .eq('id', soSubmissionId)
    .single();

  console.log('Form Submission form_id:', formSubmission?.form_id);
  console.log('Expected form_id (SO):', soFormId);
  console.log('Match:', formSubmission?.form_id === soFormId);

  // Now simulate what executeStageActions does
  const stageId = ddRecord.workflow_status || 'new';
  const effectiveFormId = formSubmission?.form_id;

  console.log('\n=== Querying DD Config ===');
  console.log('stageId:', stageId);
  console.log('effectiveFormId:', effectiveFormId);
  console.log('tenantId:', tenantId);

  const { data: ddConfig, error: configError } = await supabase
    .from('form_due_diligence_config')
    .select('workflow_stages')
    .eq('form_id', effectiveFormId)
    .eq('tenant_id', tenantId)
    .single();

  if (configError) {
    console.error('DD Config error:', configError);
    return;
  }

  console.log('DD Config found:', !!ddConfig);
  console.log('Workflow stages count:', ddConfig?.workflow_stages?.length);

  const workflowStages = ddConfig?.workflow_stages || [];
  const stage = workflowStages.find(s => s.id === stageId);

  console.log('\n=== Finding Stage ===');
  console.log('Looking for stage:', stageId);
  console.log('Stage found:', !!stage);
  
  if (stage) {
    console.log('Stage label:', stage.label);
    console.log('Stage is_initial:', stage.is_initial);
    
    const stageActions = stage.actions || stage.stage_actions;
    console.log('stageActions:', JSON.stringify(stageActions));
    
    const sendContracts = stageActions?.send_contracts || [];
    console.log('send_contracts:', sendContracts);
    
    if (sendContracts.length > 0) {
      console.log('\n=== Contract Fields Check ===');
      
      // Get the form fields
      const { data: form } = await supabase
        .from('form')
        .select('fields')
        .eq('id', effectiveFormId)
        .single();

      for (const fieldId of sendContracts) {
        const field = (form?.fields || []).find(f => f.id === fieldId || f.name === fieldId);
        console.log(`\nField ${fieldId}:`);
        if (field) {
          console.log('  Found:', field.label);
          console.log('  Type:', field.type);
          console.log('  contract_form_id:', field.contract_form_id);
        } else {
          console.log('  NOT FOUND !!!');
        }
      }

      // Check if the submission has data for these fields
      const { data: subData } = await supabase
        .from('form_submission')
        .select('submission_data')
        .eq('id', soSubmissionId)
        .single();

      console.log('\n=== Submission Data Check ===');
      for (const fieldId of sendContracts) {
        const value = subData?.submission_data?.[fieldId];
        console.log(`${fieldId}:`, value ? JSON.stringify(value) : 'NO DATA');
      }
    }
  } else {
    console.log('Available stages:', workflowStages.map(s => s.id));
  }
}

testExecution().catch(console.error);
