import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.DEV_SUPABASE_URL;
const supabaseKey = process.env.DEV_SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function debugHistory() {
  const soDDRecordId = '6ec407d8-2847-429d-a286-c261b9662ab4';
  const esoDDRecordId = 'b84eb40f-e582-4da7-937b-739f485079ef';

  console.log('=== DD Record History Comparison ===\n');

  for (const ddId of [soDDRecordId, esoDDRecordId]) {
    const { data: ddRecord } = await supabase
      .from('form_submission_due_diligence')
      .select('id, form_submission_id, workflow_status, history_log, created_at')
      .eq('id', ddId)
      .single();

    console.log('\n' + '='.repeat(60));
    console.log('DD Record ID:', ddId);
    console.log('Form Submission ID:', ddRecord?.form_submission_id);
    console.log('Workflow Status:', ddRecord?.workflow_status);
    console.log('Created At:', ddRecord?.created_at);
    
    console.log('\nHistory Log:');
    const history = ddRecord?.history_log || [];
    for (const entry of history) {
      console.log(`  ${entry.timestamp}: ${entry.event_type}`);
      if (entry.details) {
        console.log(`    Details: ${JSON.stringify(entry.details)}`);
      }
    }

    // Check for any contract instances linked to this form submission
    const { data: contracts } = await supabase
      .from('contract_instance')
      .select('id, status, sent_at, source_contact_field_id, created_at')
      .eq('form_submission_id', ddRecord?.form_submission_id);

    console.log('\nContract Instances:', contracts?.length || 0);
    for (const c of contracts || []) {
      console.log(`  ${c.id}: field=${c.source_contact_field_id} status=${c.status} sent=${c.sent_at} created=${c.created_at}`);
    }
  }
}

debugHistory().catch(console.error);
