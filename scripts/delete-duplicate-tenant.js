import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.DEV_SUPABASE_URL;
const supabaseKey = process.env.DEV_SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

const TENANT_TO_DELETE = '91cee5fe-abc4-4fdc-ad03-ed54e90a1e97';
const TENANT_TO_KEEP = 'fd82da65-aab7-4a5c-85b8-b2febeb2003d';

async function run() {
  console.log('=== Tenant Deletion Script ===');
  console.log(`Keeping: ${TENANT_TO_KEEP}`);
  console.log(`Deleting: ${TENANT_TO_DELETE}`);
  console.log('');

  const { data: keepTenant } = await supabase
    .from('tenant')
    .select('id, name, slug')
    .eq('id', TENANT_TO_KEEP)
    .single();

  const { data: deleteTenant } = await supabase
    .from('tenant')
    .select('id, name, slug')
    .eq('id', TENANT_TO_DELETE)
    .single();

  console.log('Tenant to KEEP:', keepTenant);
  console.log('Tenant to DELETE:', deleteTenant);
  console.log('');

  if (!keepTenant) {
    console.error('Tenant to keep not found!');
    process.exit(1);
  }

  const tablesWithTenantId = [
    'portal_navigation_item',
    'portal_menu', 
    'navigation_item',
    'system_settings',
    'blog_post',
    'resource',
    'event',
    'role',
    'member',
    'organization',
    'speaker',
    'card_deck',
    'card',
    'page',
    'form',
    'workflow',
    'email_template',
    'voucher_code',
    'custom_field'
  ];

  console.log('=== Step 1: Reassigning unscoped records ===');
  for (const table of tablesWithTenantId) {
    try {
      const { data: nullRecords } = await supabase
        .from(table)
        .select('id')
        .is('tenant_id', null);

      if (nullRecords && nullRecords.length > 0) {
        const ids = nullRecords.map(r => r.id);
        const { error } = await supabase
          .from(table)
          .update({ tenant_id: TENANT_TO_KEEP })
          .in('id', ids);
        
        if (error) {
          console.log(`  ${table}: ERROR - ${error.message}`);
        } else {
          console.log(`  ${table}: Reassigned ${ids.length} records`);
        }
      }
    } catch (err) {
      // Table may not have tenant_id column
    }
  }

  if (!deleteTenant) {
    console.log('\nTenant to delete not found - may already be deleted.');
    process.exit(0);
  }

  console.log('\n=== Step 2: Finding organizations to delete ===');
  
  const { data: orgsToDelete } = await supabase
    .from('organization')
    .select('id')
    .eq('tenant_id', TENANT_TO_DELETE);
  
  const orgIds = orgsToDelete?.map(o => o.id) || [];
  console.log(`  Found ${orgIds.length} organizations to delete`);

  if (orgIds.length > 0) {
    console.log('\n=== Step 2a: Deleting members via organization_id ===');
    
    const { data: membersViaOrg } = await supabase
      .from('member')
      .select('id')
      .in('organization_id', orgIds);
    
    if (membersViaOrg && membersViaOrg.length > 0) {
      const memberIds = membersViaOrg.map(m => m.id);
      console.log(`  Found ${memberIds.length} members to delete via org`);
      
      for (const depTable of ['member_note', 'booking', 'program_ticket', 'team_member', 'role_member_field_permission', 'member_session', 'tenant_user_member_link']) {
        try {
          const { error } = await supabase
            .from(depTable)
            .delete()
            .in('member_id', memberIds);
          if (!error) console.log(`    ${depTable}: cleaned`);
        } catch (err) {}
      }
      
      const { error: delMemberErr } = await supabase
        .from('member')
        .delete()
        .in('id', memberIds);
      
      if (delMemberErr) {
        console.log(`  member: ERROR - ${delMemberErr.message}`);
      } else {
        console.log(`  member: Deleted ${memberIds.length} records`);
      }
    }

    console.log('\n=== Step 2b: Deleting organization dependencies ===');
    for (const depTable of ['organization_note']) {
      try {
        const { error } = await supabase
          .from(depTable)
          .delete()
          .in('organization_id', orgIds);
        if (!error) console.log(`    ${depTable}: cleaned`);
      } catch (err) {}
    }

    console.log('\n=== Step 2c: Deleting organizations ===');
    const { error: delOrgErr } = await supabase
      .from('organization')
      .delete()
      .in('id', orgIds);
    
    if (delOrgErr) {
      console.log(`  organization: ERROR - ${delOrgErr.message}`);
    } else {
      console.log(`  organization: Deleted ${orgIds.length} records`);
    }
  }

  console.log('\n=== Step 2d: Reassigning system roles to keep tenant ===');
  const { data: systemRoles } = await supabase
    .from('role')
    .select('id, name, is_system')
    .eq('tenant_id', TENANT_TO_DELETE)
    .eq('is_system', true);
  
  if (systemRoles && systemRoles.length > 0) {
    console.log(`  Found ${systemRoles.length} system roles to reassign`);
    for (const role of systemRoles) {
      const { error } = await supabase
        .from('role')
        .update({ tenant_id: TENANT_TO_KEEP })
        .eq('id', role.id);
      if (error) {
        console.log(`    ${role.name}: ERROR - ${error.message}`);
      } else {
        console.log(`    ${role.name}: Reassigned to keep tenant`);
      }
    }
  }

  console.log('\n=== Step 2e: Deleting non-system roles ===');
  const { data: nonSystemRoles } = await supabase
    .from('role')
    .select('id, name')
    .eq('tenant_id', TENANT_TO_DELETE)
    .or('is_system.is.null,is_system.eq.false');
  
  if (nonSystemRoles && nonSystemRoles.length > 0) {
    const roleIds = nonSystemRoles.map(r => r.id);
    await supabase.from('role_member_field_permission').delete().in('role_id', roleIds);
    const { error } = await supabase.from('role').delete().in('id', roleIds);
    if (error) {
      console.log(`  role: ERROR - ${error.message}`);
    } else {
      console.log(`  role: Deleted ${roleIds.length} non-system roles`);
    }
  }

  console.log('\n=== Step 3: Deleting other tenant-scoped records ===');
  
  const deletionOrder = [
    'portal_navigation_item',
    'portal_menu',
    'navigation_item',
    'system_settings',
    'blog_post',
    'resource',
    'event',
    'speaker',
    'card',
    'card_deck',
    'page',
    'form_submission',
    'form',
    'workflow',
    'email_template',
    'voucher_code',
    'custom_field',
    'xero_token'
  ];

  for (const table of deletionOrder) {
    try {
      const { data: records } = await supabase
        .from(table)
        .select('id')
        .eq('tenant_id', TENANT_TO_DELETE);

      if (records && records.length > 0) {
        const ids = records.map(r => r.id);
        const { error } = await supabase
          .from(table)
          .delete()
          .in('id', ids);

        if (error) {
          console.log(`  ${table}: ERROR - ${error.message}`);
        } else {
          console.log(`  ${table}: Deleted ${ids.length} records`);
        }
      }
    } catch (err) {
      // Skip tables that don't exist or don't have tenant_id
    }
  }

  console.log('\n=== Step 3a: Checking remaining roles for delete tenant ===');
  const { data: remainingRoles } = await supabase
    .from('role')
    .select('id, name, tenant_id, is_system')
    .eq('tenant_id', TENANT_TO_DELETE);
  
  if (remainingRoles && remainingRoles.length > 0) {
    console.log(`  Found ${remainingRoles.length} remaining roles:`);
    for (const role of remainingRoles) {
      console.log(`    - ${role.name} (is_system: ${role.is_system})`);
      
      const { error } = await supabase
        .from('role')
        .update({ tenant_id: TENANT_TO_KEEP })
        .eq('id', role.id);
      
      if (error) {
        console.log(`      Reassign ERROR: ${error.message}`);
      } else {
        console.log(`      Reassigned to keep tenant`);
      }
    }
  }

  console.log('\n=== Step 4: Deleting tenant record ===');
  const { error: deleteTenantError } = await supabase
    .from('tenant')
    .delete()
    .eq('id', TENANT_TO_DELETE);

  if (deleteTenantError) {
    console.error('Failed to delete tenant:', deleteTenantError.message);
  } else {
    console.log('Tenant deleted successfully!');
  }

  console.log('\n=== Verification ===');
  const { data: remainingTenants } = await supabase
    .from('tenant')
    .select('id, name, slug');
  
  console.log('Remaining tenants:', remainingTenants);
}

run().catch(console.error);
