import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.DEV_SUPABASE_URL;
const supabaseKey = process.env.DEV_SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function debugConfigUpdates() {
  const soFormId = 'dd04a19b-019b-4cb2-9a7f-3a77027e9857';
  const esoFormId = 'a9ec1559-495a-4705-9da9-d51517be7bb6';

  console.log('=== DD Config Update Times ===\n');

  for (const formId of [soFormId, esoFormId]) {
    const { data: config } = await supabase
      .from('form_due_diligence_config')
      .select('id, form_id, created_at, updated_at, workflow_stages')
      .eq('form_id', formId)
      .single();

    const { data: form } = await supabase
      .from('form')
      .select('name')
      .eq('id', formId)
      .single();

    console.log('\n' + '='.repeat(60));
    console.log('Form:', form?.name);
    console.log('DD Config ID:', config?.id);
    console.log('Created At:', config?.created_at);
    console.log('Updated At:', config?.updated_at);
    
    // Check the NEW stage send_contracts
    const newStage = config?.workflow_stages?.find(s => s.id === 'new');
    console.log('NEW stage send_contracts:', JSON.stringify(newStage?.stage_actions?.send_contracts || newStage?.actions?.send_contracts));
  }

  // Also check if the SO form itself was updated
  console.log('\n\n=== Form Update Times ===\n');
  
  for (const formId of [soFormId, esoFormId]) {
    const { data: form } = await supabase
      .from('form')
      .select('id, name, created_at, updated_at')
      .eq('id', formId)
      .single();

    console.log('\n' + '='.repeat(60));
    console.log('Form:', form?.name);
    console.log('Created At:', form?.created_at);
    console.log('Updated At:', form?.updated_at);
  }
}

debugConfigUpdates().catch(console.error);
