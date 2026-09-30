import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Error: SUPABASE_URL and SUPABASE_SERVICE_KEY environment variables required');
  process.exit(1);
}

console.log('='.repeat(60));
console.log('Check system_settings Table Structure');
console.log('='.repeat(60));
console.log('');

const supabase = createClient(supabaseUrl, supabaseKey);

async function main() {
  try {
    console.log('1. Checking system_settings table structure...');
    
    const { data: settings, error } = await supabase
      .from('system_settings')
      .select('*')
      .limit(5);

    if (error) {
      console.error('Error querying system_settings:', error.message);
      process.exit(1);
    }

    if (settings && settings.length > 0) {
      console.log(`   Found ${settings.length} sample settings`);
      console.log('   Columns:', Object.keys(settings[0]).join(', '));
      
      const hasTenantId = 'tenant_id' in settings[0];
      console.log(`   Has tenant_id column: ${hasTenantId}`);
      
      if (!hasTenantId) {
        console.log('\n' + '='.repeat(60));
        console.log('ISSUE FOUND: system_settings table is missing tenant_id column');
        console.log('='.repeat(60));
        console.log(`
The system_settings table needs to be migrated to add tenant_id for multi-tenancy.

MIGRATION SQL - Run this in Supabase SQL Editor:
================================================

-- Step 1: Add tenant_id column
ALTER TABLE system_settings 
ADD COLUMN IF NOT EXISTS tenant_id VARCHAR REFERENCES tenant(id);

-- Step 2: Drop any existing unique constraint on setting_key alone
-- First check what constraints exist:
SELECT constraint_name 
FROM information_schema.table_constraints 
WHERE table_name = 'system_settings' 
  AND constraint_type = 'UNIQUE';

-- Then drop the constraint (replace with actual name from above query):
-- ALTER TABLE system_settings DROP CONSTRAINT IF EXISTS system_settings_setting_key_key;

-- Step 3: Add tenant-scoped unique constraint
ALTER TABLE system_settings 
ADD CONSTRAINT system_settings_tenant_setting_unique 
UNIQUE (tenant_id, setting_key);

-- Step 4: Update existing records to set tenant_id if needed
-- (This depends on how you want to assign existing settings to tenants)
`);
      }
    } else {
      console.log('   Table is empty or not accessible');
    }

    console.log('\n2. Checking email_footer settings...');
    const { data: emailFooters } = await supabase
      .from('system_settings')
      .select('*')
      .eq('setting_key', 'email_footer');

    if (emailFooters && emailFooters.length > 0) {
      console.log(`   Found ${emailFooters.length} email_footer setting(s):`);
      for (const f of emailFooters) {
        console.log(`   - id: ${f.id}`);
        if (f.tenant_id) console.log(`     tenant_id: ${f.tenant_id}`);
        const preview = f.setting_value?.substring(0, 80) || '(empty)';
        console.log(`     value preview: ${preview}...`);
      }
    } else {
      console.log('   No email_footer settings found');
    }

  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();
