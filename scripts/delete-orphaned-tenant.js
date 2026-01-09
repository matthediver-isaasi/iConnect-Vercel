/**
 * Delete Orphaned Tenant Script
 * 
 * This script safely deletes a tenant and all related data when provisioning
 * fails partway through, leaving orphaned records.
 * 
 * Usage: node scripts/delete-orphaned-tenant.js <tenant-id>
 */

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.DEV_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.DEV_SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('Missing Supabase environment variables');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

const tenantId = process.argv[2];

if (!tenantId) {
  console.error('Usage: node scripts/delete-orphaned-tenant.js <tenant-id>');
  process.exit(1);
}

async function deleteTenant() {
  console.log(`Deleting tenant: ${tenantId}`);
  
  try {
    // First verify the tenant exists
    const { data: tenant, error: tenantError } = await supabase
      .from('tenant')
      .select('id, name, slug')
      .eq('id', tenantId)
      .single();
    
    if (tenantError || !tenant) {
      console.error('Tenant not found:', tenantId);
      process.exit(1);
    }
    
    console.log(`Found tenant: ${tenant.name} (${tenant.slug})`);
    
    // Delete in order of dependencies (most dependent first)
    
    // 1. Delete tenant_user_member_link
    const { error: linkError } = await supabase
      .from('tenant_user_member_link')
      .delete()
      .eq('tenant_id', tenantId);
    if (linkError) console.log('tenant_user_member_link:', linkError.message);
    else console.log('Deleted tenant_user_member_link records');
    
    // 2. Delete member_credentials (via member)
    const { data: members } = await supabase
      .from('member')
      .select('id')
      .eq('tenant_id', tenantId);
    
    if (members?.length > 0) {
      const memberIds = members.map(m => m.id);
      const { error: credError } = await supabase
        .from('member_credentials')
        .delete()
        .in('member_id', memberIds);
      if (credError) console.log('member_credentials:', credError.message);
      else console.log(`Deleted member_credentials for ${memberIds.length} members`);
    }
    
    // 3. Delete members
    const { error: memberError } = await supabase
      .from('member')
      .delete()
      .eq('tenant_id', tenantId);
    if (memberError) console.log('member:', memberError.message);
    else console.log('Deleted member records');
    
    // 4. Delete tenant_user_credentials (via tenant_user)
    const { data: tenantUsers } = await supabase
      .from('tenant_user')
      .select('id')
      .eq('tenant_id', tenantId);
    
    if (tenantUsers?.length > 0) {
      const userIds = tenantUsers.map(u => u.id);
      const { error: tuCredError } = await supabase
        .from('tenant_user_credentials')
        .delete()
        .in('tenant_user_id', userIds);
      if (tuCredError) console.log('tenant_user_credentials:', tuCredError.message);
      else console.log(`Deleted tenant_user_credentials for ${userIds.length} users`);
    }
    
    // 5. Delete tenant_users
    const { error: tuError } = await supabase
      .from('tenant_user')
      .delete()
      .eq('tenant_id', tenantId);
    if (tuError) console.log('tenant_user:', tuError.message);
    else console.log('Deleted tenant_user records');
    
    // 6. Delete role_member_field_permission (via roles)
    const { data: roles } = await supabase
      .from('role')
      .select('id')
      .eq('tenant_id', tenantId);
    
    if (roles?.length > 0) {
      const roleIds = roles.map(r => r.id);
      
      const { error: mfpError } = await supabase
        .from('role_member_field_permission')
        .delete()
        .in('role_id', roleIds);
      if (mfpError) console.log('role_member_field_permission:', mfpError.message);
      else console.log('Deleted role_member_field_permission records');
      
      const { error: ofpError } = await supabase
        .from('role_organization_field_permission')
        .delete()
        .in('role_id', roleIds);
      if (ofpError) console.log('role_organization_field_permission:', ofpError.message);
      else console.log('Deleted role_organization_field_permission records');
    }
    
    // 7. Delete roles
    const { error: roleError } = await supabase
      .from('role')
      .delete()
      .eq('tenant_id', tenantId);
    if (roleError) console.log('role:', roleError.message);
    else console.log('Deleted role records');
    
    // 8. Delete organizations
    const { error: orgError } = await supabase
      .from('organization')
      .delete()
      .eq('tenant_id', tenantId);
    if (orgError) console.log('organization:', orgError.message);
    else console.log('Deleted organization records');
    
    // 9. Finally delete the tenant
    const { error: delTenantError } = await supabase
      .from('tenant')
      .delete()
      .eq('id', tenantId);
    if (delTenantError) {
      console.error('Failed to delete tenant:', delTenantError.message);
      process.exit(1);
    }
    
    console.log(`\nSuccessfully deleted tenant: ${tenant.name} (${tenant.slug})`);
    
  } catch (err) {
    console.error('Unexpected error:', err);
    process.exit(1);
  }
}

deleteTenant();
