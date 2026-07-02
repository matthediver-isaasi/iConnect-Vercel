import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

async function findSubmission() {
  // Get recent submissions
  const { data: submissions, error } = await supabase
    .from('form_submission')
    .select('id, form_id, form_name, created_date')
    .order('created_date', { ascending: false })
    .limit(10);

  if (error) {
    console.error('Error:', error);
    return;
  }

  console.log('Recent submissions:');
  submissions.forEach(s => {
    console.log(`  ${s.id} - ${s.form_name} - ${s.created_date}`);
  });
}

findSubmission();
