import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.DEV_SUPABASE_URL;
const supabaseKey = process.env.DEV_SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function backfillFormIds() {
  console.log('Backfilling form_id for stage_email_action entries...');
  
  const tenantId = '21296ad6-1350-483a-a90c-1b06ece70501';
  
  // Get all stage_email_action entries without form_id
  const { data: actions, error } = await supabase
    .from('stage_email_action')
    .select('*')
    .eq('tenant_id', tenantId)
    .is('form_id', null);
  
  if (error) {
    console.error('Error fetching actions:', error);
    return;
  }
  
  console.log(`Found ${actions?.length || 0} actions without form_id`);
  
  // Get the forms with DD configs
  const { data: ddConfigs } = await supabase
    .from('form_due_diligence_config')
    .select('form_id, workflow_stages')
    .eq('tenant_id', tenantId);
  
  console.log('DD configs:', ddConfigs?.map(c => c.form_id));
  
  // For each action, try to match it to a form based on the field IDs
  for (const action of actions || []) {
    console.log(`\nAction: ${action.id}`);
    console.log(`  Stage: ${action.due_diligence_stage_id}`);
    console.log(`  Recipient field: ${action.recipient_email_field}`);
    
    // Check which form has this field
    for (const config of ddConfigs || []) {
      const { data: form } = await supabase
        .from('form')
        .select('id, name, fields')
        .eq('id', config.form_id)
        .single();
      
      if (!form) continue;
      
      const fieldsStr = JSON.stringify(form.fields || {});
      if (fieldsStr.includes(action.recipient_email_field)) {
        console.log(`  -> Matches form: ${form.name} (${form.id})`);
        
        // Update the action with form_id
        const { error: updateError } = await supabase
          .from('stage_email_action')
          .update({ form_id: form.id })
          .eq('id', action.id);
        
        if (updateError) {
          console.error(`  -> Update error:`, updateError);
        } else {
          console.log(`  -> Updated successfully`);
        }
        break;
      }
    }
  }
  
  console.log('\nBackfill complete!');
}

backfillFormIds().catch(console.error);
