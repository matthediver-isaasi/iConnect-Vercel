import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.DEST_SUPABASE_URL;
const supabaseKey = process.env.DEST_SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing DEST_SUPABASE_URL or DEST_SUPABASE_KEY environment variables');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function addColumn() {
  console.log('Adding communications_opted_out_all column to member table...');
  
  const { error } = await supabase.rpc('exec_sql', {
    sql: `
      ALTER TABLE member 
      ADD COLUMN IF NOT EXISTS communications_opted_out_all BOOLEAN DEFAULT false;
    `
  });
  
  if (error) {
    // Try direct query if RPC not available
    console.log('RPC not available, trying direct approach...');
    
    // Check if column exists first
    const { data: columns, error: checkError } = await supabase
      .from('member')
      .select('communications_opted_out_all')
      .limit(1);
    
    if (!checkError) {
      console.log('Column already exists or was added successfully!');
      return;
    }
    
    if (checkError.message.includes('does not exist')) {
      console.log('Column does not exist. Please run the SQL manually in Supabase SQL Editor:');
      console.log(`
ALTER TABLE member 
ADD COLUMN IF NOT EXISTS communications_opted_out_all BOOLEAN DEFAULT false;
      `);
      process.exit(1);
    }
    
    console.error('Error:', checkError);
    process.exit(1);
  }
  
  console.log('Column added successfully!');
}

addColumn();
