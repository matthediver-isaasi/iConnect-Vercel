import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.DEV_SUPABASE_URL;
const supabaseKey = process.env.DEV_SUPABASE_SERVICE_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

// Get the Reference Request submissions
const submissionIds = [
  'd83d5216-e298-46ab-9982-e9181555d042',  // Sharon's Reference Request
  '36fa7b1c-4d41-46de-913d-7ba8466d2322'   // Herve's Reference Request
];

const { data: submissions, error } = await supabase
  .from('form_submission')
  .select('id, form_id, submission_data, created_date')
  .in('id', submissionIds);

if (error) {
  console.error('Error:', error);
  process.exit(1);
}

console.log('=== Reference Request Submission Data ===\n');

for (const sub of submissions) {
  console.log('--- Submission:', sub.id, '---');
  console.log('Created:', sub.created_date);
  console.log('Form ID:', sub.form_id);
  console.log('\nSubmission Data:');
  console.log(JSON.stringify(sub.submission_data, null, 2));
  console.log('\n');
}

// Also check the Membership agreement submissions that work
const workingIds = [
  'ab486c7b-29f8-4430-afff-c6f9a2db111a',  // Sharon's Membership agreement
  '1176fc4d-3d4b-4f4d-b932-7c27986f5d96'   // Herve's Membership agreement  
];

const { data: workingSubs } = await supabase
  .from('form_submission')
  .select('id, form_id, submission_data')
  .in('id', workingIds);

console.log('=== Membership Agreement Submission Data (working) ===\n');
for (const sub of (workingSubs || [])) {
  console.log('--- Submission:', sub.id, '---');
  
  // Find signature fields
  const sigFields = Object.entries(sub.submission_data || {}).filter(([k, v]) => 
    typeof v === 'object' && v?.type === 'signature'
  );
  
  console.log('Signature fields found:', sigFields.length);
  sigFields.forEach(([key, val]) => {
    console.log(`  ${key}: type=${val.type}`);
  });
  console.log('');
}
