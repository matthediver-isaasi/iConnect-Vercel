// Script to add timezone field to event table
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://lvmzliemqnieeoruhkik.supabase.co';
const supabaseKey = process.env.DEST_SUPABASE_KEY;

if (!supabaseKey) {
  console.error('DEST_SUPABASE_KEY is required');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function main() {
  console.log('Adding timezone column to event table...');
  
  // Try to add the column - Supabase will ignore if it already exists with IF NOT EXISTS
  const { data, error } = await supabase.rpc('exec_sql', {
    sql: `ALTER TABLE event ADD COLUMN IF NOT EXISTS timezone TEXT;`
  });
  
  if (error) {
    console.log('RPC method not available, trying alternative approach...');
    
    // Alternative: Try to update a record with the new field - if column doesn't exist, it will fail
    // If it does exist, we'll just update nothing
    const { error: updateError } = await supabase
      .from('event')
      .update({ timezone: null })
      .eq('id', '00000000-0000-0000-0000-000000000000'); // Non-existent ID
    
    if (updateError) {
      if (updateError.code === 'PGRST204' || updateError.message.includes('no rows')) {
        console.log('Column may already exist or no rows matched (expected)');
      } else if (updateError.message.includes('column') && updateError.message.includes('does not exist')) {
        console.error('Timezone column does not exist. Please add it manually in Supabase dashboard:');
        console.error('ALTER TABLE event ADD COLUMN timezone TEXT;');
        process.exit(1);
      } else {
        console.log('Update test result:', updateError.message);
      }
    }
    
    // Verify the column exists now by fetching an event
    const { data: sampleEvent, error: sampleError } = await supabase
      .from('event')
      .select('timezone')
      .limit(1);
    
    if (sampleError) {
      console.error('Column still not available:', sampleError.message);
      console.log('\nPlease run this SQL in the Supabase dashboard:');
      console.log('ALTER TABLE event ADD COLUMN timezone TEXT;');
      process.exit(1);
    } else {
      console.log('SUCCESS: timezone column is available on event table');
    }
  } else {
    console.log('Column added successfully via RPC');
  }
}

main().catch(console.error);
