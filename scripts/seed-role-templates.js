import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.DEV_SUPABASE_URL;
const supabaseKey = process.env.DEV_SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

const SUPER_ADMIN_ROLE_ID = '5be10af3-cfd9-4e25-80c9-886e804314da';
const MEMBER_ROLE_ID = 'c94cdcfd-d0f0-497a-ab5e-c742baacf049';

async function run() {
  console.log('=== Seed Role Templates from GFI ===\n');

  const { data: superAdminRole, error: saError } = await supabase
    .from('role')
    .select('*')
    .eq('id', SUPER_ADMIN_ROLE_ID)
    .single();

  if (saError || !superAdminRole) {
    console.error('Failed to fetch Super Admin role:', saError?.message);
    process.exit(1);
  }

  const { data: memberRole, error: mError } = await supabase
    .from('role')
    .select('*')
    .eq('id', MEMBER_ROLE_ID)
    .single();

  if (mError || !memberRole) {
    console.error('Failed to fetch Member role:', mError?.message);
    process.exit(1);
  }

  const { data: saPermissions } = await supabase
    .from('role_member_field_permission')
    .select('*')
    .eq('role_id', SUPER_ADMIN_ROLE_ID);

  const { data: memberPermissions } = await supabase
    .from('role_member_field_permission')
    .select('*')
    .eq('role_id', MEMBER_ROLE_ID);

  const { data: saOrgPermissions } = await supabase
    .from('role_organization_field_permission')
    .select('*')
    .eq('role_id', SUPER_ADMIN_ROLE_ID);

  const { data: memberOrgPermissions } = await supabase
    .from('role_organization_field_permission')
    .select('*')
    .eq('role_id', MEMBER_ROLE_ID);

  const roleTemplates = [
    {
      id: crypto.randomUUID(),
      name: superAdminRole.name,
      is_system: true,
      excluded_features: superAdminRole.excluded_features || [],
      member_field_permissions: (saPermissions || []).map(p => ({
        field_key: p.field_key,
        permission: p.permission
      })),
      organization_field_permissions: (saOrgPermissions || []).map(p => ({
        field_key: p.field_key,
        permission: p.permission
      }))
    },
    {
      id: crypto.randomUUID(),
      name: memberRole.name,
      is_system: false,
      excluded_features: memberRole.excluded_features || [],
      member_field_permissions: (memberPermissions || []).map(p => ({
        field_key: p.field_key,
        permission: p.permission
      })),
      organization_field_permissions: (memberOrgPermissions || []).map(p => ({
        field_key: p.field_key,
        permission: p.permission
      }))
    }
  ];

  console.log('Super Admin template:');
  console.log('  - Name:', roleTemplates[0].name);
  console.log('  - Is System:', roleTemplates[0].is_system);
  console.log('  - Excluded Features:', roleTemplates[0].excluded_features.length);
  console.log('  - Member Field Permissions:', roleTemplates[0].member_field_permissions.length);
  console.log('  - Org Field Permissions:', roleTemplates[0].organization_field_permissions.length);
  
  console.log('\nMember template:');
  console.log('  - Name:', roleTemplates[1].name);
  console.log('  - Is System:', roleTemplates[1].is_system);
  console.log('  - Excluded Features:', roleTemplates[1].excluded_features.length);
  console.log('  - Member Field Permissions:', roleTemplates[1].member_field_permissions.length);
  console.log('  - Org Field Permissions:', roleTemplates[1].organization_field_permissions.length);

  const { error: saveError } = await supabase
    .from('platform_preferences')
    .upsert({
      key: 'default_role_templates',
      value: { roles: roleTemplates },
      description: 'Default role configurations to provision for new tenants',
      updated_at: new Date().toISOString()
    }, { onConflict: 'key' });

  if (saveError) {
    console.error('\nFailed to save templates:', saveError.message);
    process.exit(1);
  }

  console.log('\n✓ Role templates saved to platform_preferences!');

  const { data: verify } = await supabase
    .from('platform_preferences')
    .select('value')
    .eq('key', 'default_role_templates')
    .single();

  console.log('\nVerification - stored', verify?.value?.roles?.length, 'role templates');
}

run().catch(console.error);
