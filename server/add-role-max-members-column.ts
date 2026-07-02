import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY environment variables');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

async function addMaxMembersColumn() {
  console.log('=== Adding max_members column to role table ===');
  
  try {
    const { error } = await supabase.rpc('exec_sql', {
      sql_query: `
        ALTER TABLE role 
        ADD COLUMN IF NOT EXISTS max_members integer DEFAULT NULL;
        
        COMMENT ON COLUMN role.max_members IS 'Maximum number of active members that can be assigned to this role. NULL means unlimited.';
      `
    });

    if (error) {
      console.log('Note: RPC method not available, trying alternative approach...');
      
      const { data: testData, error: testError } = await supabase
        .from('role')
        .select('max_members')
        .limit(1);
      
      if (testError && testError.message.includes('max_members')) {
        console.log('\nThe column does not exist yet.');
        console.log('\nPlease run this SQL in your Supabase SQL Editor:');
        console.log('----------------------------------------');
        console.log(`
ALTER TABLE role 
ADD COLUMN IF NOT EXISTS max_members integer DEFAULT NULL;

COMMENT ON COLUMN role.max_members IS 'Maximum number of active members that can be assigned to this role. NULL means unlimited.';
        `);
        console.log('----------------------------------------');
        console.log('\nAfter running the SQL, the max_members column will be available for role capacity limits.');
      } else if (!testError) {
        console.log('Column already exists! Current data sample:');
        console.log(testData);
      } else {
        console.log('Error checking column:', testError.message);
      }
    } else {
      console.log('Column added successfully via RPC!');
    }
    
    console.log('\nVerifying column existence...');
    const { data: verifyData, error: verifyError } = await supabase
      .from('role')
      .select('id, name, max_members')
      .limit(5);
    
    if (verifyError) {
      console.log('Verification error:', verifyError.message);
    } else {
      console.log('Sample roles with max_members:', verifyData);
    }
    
  } catch (err) {
    console.error('Error:', err);
  }
}

addMaxMembersColumn();
