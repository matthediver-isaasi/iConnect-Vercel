import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function addIsPrimaryColumn() {
  console.log('Adding is_primary column to organization table...');
  
  const { error } = await supabase.rpc('exec_sql', {
    sql: `
      ALTER TABLE organization 
      ADD COLUMN IF NOT EXISTS is_primary BOOLEAN DEFAULT FALSE;
      
      COMMENT ON COLUMN organization.is_primary IS 'Indicates the primary organization created during tenant provisioning. Cannot be deleted.';
    `
  });
  
  if (error) {
    console.error('Error adding column:', error);
    console.log('Note: You may need to add this column manually in the Supabase dashboard:');
    console.log('ALTER TABLE organization ADD COLUMN IF NOT EXISTS is_primary BOOLEAN DEFAULT FALSE;');
    return false;
  }
  
  console.log('Successfully added is_primary column');
  return true;
}

async function setExistingPrimaryOrganizations() {
  console.log('Setting is_primary=true for existing primary organizations...');
  
  const { data: tenants, error: tenantsError } = await supabase
    .from('tenant')
    .select('id, name');
  
  if (tenantsError) {
    console.error('Error fetching tenants:', tenantsError);
    return;
  }
  
  console.log(`Found ${tenants.length} tenants`);
  
  for (const tenant of tenants) {
    const { data: org, error: orgError } = await supabase
      .from('organization')
      .select('id, name')
      .eq('tenant_id', tenant.id)
      .eq('name', tenant.name)
      .single();
    
    if (orgError) {
      console.log(`No matching organization found for tenant "${tenant.name}"`);
      continue;
    }
    
    const { error: updateError } = await supabase
      .from('organization')
      .update({ is_primary: true })
      .eq('id', org.id);
    
    if (updateError) {
      console.error(`Error updating organization "${org.name}":`, updateError);
    } else {
      console.log(`Set is_primary=true for organization "${org.name}" (tenant: ${tenant.name})`);
    }
  }
}

async function main() {
  const columnAdded = await addIsPrimaryColumn();
  
  if (columnAdded) {
    await setExistingPrimaryOrganizations();
  } else {
    console.log('\nIf the column was added manually, run this script again to set existing primary organizations.');
  }
  
  console.log('\nMigration complete.');
}

main().catch(console.error);
