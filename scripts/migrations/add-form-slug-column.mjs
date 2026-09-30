import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.DEST_SUPABASE_URL;
const supabaseKey = process.env.DEST_SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing DEST_SUPABASE_URL or DEST_SUPABASE_KEY environment variables');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function addFormSlugColumn() {
  console.log('Adding form_slug column to navigation_item table...');
  
  const { data, error } = await supabase.rpc('exec_sql', {
    sql: `
      ALTER TABLE navigation_item 
      ADD COLUMN IF NOT EXISTS form_slug TEXT;
    `
  });

  if (error) {
    console.error('Error adding column via RPC:', error.message);
    console.log('Trying direct SQL approach...');
    
    const { error: error2 } = await supabase
      .from('navigation_item')
      .select('form_slug')
      .limit(1);
    
    if (error2 && error2.message.includes('column')) {
      console.error('Column does not exist and could not be added automatically.');
      console.log('\nPlease run this SQL in your Supabase SQL Editor:');
      console.log('----------------------------------------');
      console.log('ALTER TABLE navigation_item ADD COLUMN IF NOT EXISTS form_slug TEXT;');
      console.log('----------------------------------------');
      process.exit(1);
    } else if (!error2) {
      console.log('Column form_slug already exists!');
    }
  } else {
    console.log('Successfully added form_slug column!');
  }
}

addFormSlugColumn().catch(console.error);
