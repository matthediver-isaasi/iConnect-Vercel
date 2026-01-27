import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.DEV_SUPABASE_URL;
const supabaseKey = process.env.DEV_SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const tenantId = '21296ad6-1350-483a-a90c-1b06ece70501';

async function debugFormFields() {
  const soFormId = 'dd04a19b-019b-4cb2-9a7f-3a77027e9857';
  const esoFormId = 'a9ec1559-495a-4705-9da9-d51517be7bb6';

  console.log('=== Form Fields Comparison ===\n');

  // The field IDs referenced in DD configs
  const referencedFieldIds = [
    'field_1768830421540', // First signatory
    'field_1768830446102', // Second signatory
    'field_1768830008963', // First referee
    'field_1768830045163', // Second referee
  ];

  for (const formId of [soFormId, esoFormId]) {
    const { data: form } = await supabase
      .from('form')
      .select('id, name, fields')
      .eq('id', formId)
      .single();

    console.log('\n' + '='.repeat(60));
    console.log('FORM:', form?.name, '(' + formId + ')');
    
    const fields = form?.fields || [];
    const contactFields = fields.filter(f => f.type === 'contact');
    
    console.log('\nAll Contact Fields:');
    for (const field of contactFields) {
      console.log(`  ${field.id}: ${field.label} (contract_form_id: ${field.contract_form_id})`);
    }
    
    console.log('\nReferenced Field IDs Check:');
    for (const refId of referencedFieldIds) {
      const found = fields.find(f => f.id === refId || f.name === refId);
      if (found) {
        console.log(`  ${refId}: FOUND - ${found.label} (type: ${found.type})`);
      } else {
        console.log(`  ${refId}: NOT FOUND !!!`);
      }
    }
  }
}

debugFormFields().catch(console.error);
