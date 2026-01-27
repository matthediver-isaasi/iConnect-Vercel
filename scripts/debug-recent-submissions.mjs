import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.DEV_SUPABASE_URL;
const supabaseKey = process.env.DEV_SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const tenantId = '21296ad6-1350-483a-a90c-1b06ece70501';

async function debugRecentSubmissions() {
  console.log('=== Recent Submissions Analysis ===\n');

  // Get SO form ID
  const soFormId = 'dd04a19b-019b-4cb2-9a7f-3a77027e9857';
  const esoFormId = 'a9ec1559-495a-4705-9da9-d51517be7bb6';

  // Get ALL form submissions from last 7 days
  const { data: submissions, error } = await supabase
    .from('form_submission')
    .select('id, form_id, created_date, submission_data, organization_id')
    .eq('tenant_id', tenantId)
    .in('form_id', [soFormId, esoFormId])
    .order('created_date', { ascending: false })
    .limit(20);

  if (error) {
    console.error('Error:', error);
    return;
  }

  console.log('Total submissions found:', submissions?.length || 0);

  for (const sub of submissions || []) {
    console.log('\n' + '='.repeat(60));
    console.log('Submission ID:', sub.id);
    console.log('Form ID:', sub.form_id);
    console.log('Form:', sub.form_id === soFormId ? 'SO Long form' : 'ESO Long form');
    console.log('Created:', sub.created_date);
    
    // Check DD submission
    const { data: ddSub } = await supabase
      .from('form_submission_due_diligence')
      .select('*')
      .eq('form_submission_id', sub.id)
      .single();

    if (ddSub) {
      console.log('\n--- DD Submission ---');
      console.log('DD ID:', ddSub.id);
      console.log('Status:', ddSub.status);
      console.log('Created:', ddSub.created_at);
      console.log('Form ID on DD:', ddSub.form_id);
    } else {
      console.log('\n!!! NO DD SUBMISSION !!!');
    }

    // Check contract instances
    const { data: contracts } = await supabase
      .from('contract_instance')
      .select('*')
      .eq('form_submission_id', sub.id);

    console.log('\n--- Contract Instances ---');
    console.log('Count:', contracts?.length || 0);
    for (const c of contracts || []) {
      console.log(`  Contract: ${c.id}`);
      console.log(`    Status: ${c.status}`);
      console.log(`    Sent At: ${c.sent_at || 'NOT SENT'}`);
      console.log(`    Source Field: ${c.source_contact_field_id}`);
      console.log(`    Signers: ${JSON.stringify(c.signers)}`);
    }

    // Check contact field values in submission data
    const submissionData = sub.submission_data || {};
    console.log('\n--- Contact Field Values ---');
    
    // SO form contact fields
    const contactFieldIds = [
      'field_1768830421540', // First signatory
      'field_1768830446102', // Second signatory
      'field_1768821417280', // ESO - might be different
    ];
    
    for (const fieldId of contactFieldIds) {
      if (submissionData[fieldId]) {
        console.log(`  ${fieldId}:`, JSON.stringify(submissionData[fieldId]));
      }
    }

    // Look for any field with contact data
    for (const [key, value] of Object.entries(submissionData)) {
      if (key.startsWith('field_') && typeof value === 'object' && value !== null) {
        if (value.email || value.first_name || value.firstName) {
          console.log(`  ${key}: ${JSON.stringify(value)}`);
        }
      }
    }
  }

  // Also check for any DD submissions without form submissions (orphans)
  console.log('\n\n=== Recent DD Submissions ===');
  
  const { data: ddSubs } = await supabase
    .from('form_submission_due_diligence')
    .select('id, form_submission_id, workflow_status, form_id, created_at')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
    .limit(10);

  for (const dd of ddSubs || []) {
    console.log(`\nDD: ${dd.id.substring(0, 8)}... form_id=${dd.form_id} status=${dd.workflow_status} created=${dd.created_at}`);
  }
}

debugRecentSubmissions().catch(console.error);
