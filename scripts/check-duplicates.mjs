import { createClient } from '@supabase/supabase-js';

// Use the DEV database which should have the multi-tenant schema
const supabaseUrl = process.env.DEV_SUPABASE_URL;
const supabaseKey = process.env.DEV_SUPABASE_SERVICE_KEY;

if (!supabaseKey || !supabaseUrl) {
  console.error('DEV_SUPABASE_SERVICE_KEY or DEV_SUPABASE_URL not set');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

const tenantId = '21296ad6-1350-483a-a90c-1b06ece70501';
const handle = 'mat-henderson';

console.log('Checking for members with handle:', handle, 'in tenant:', tenantId);
console.log('Using Supabase URL:', supabaseUrl);

const { data, error } = await supabase
  .from('member')
  .select('id, first_name, last_name, email, handle, tenant_id, organization_id, created_at')
  .eq('handle', handle)
  .eq('tenant_id', tenantId);

if (error) {
  console.error('Error:', error.message);
} else {
  console.log('Found', data.length, 'member(s):');
  console.log(JSON.stringify(data, null, 2));
}

// Also check tenant_membership for this handle
if (data && data.length > 0) {
  console.log('\n--- Checking tenant_membership for duplicates ---');
  const { data: memberships, error: memErr } = await supabase
    .from('tenant_membership')
    .select('id, member_id, identity_id, tenant_id')
    .eq('tenant_id', tenantId)
    .in('member_id', data.map(m => m.id));

  if (memErr) {
    console.error('Membership error:', memErr.message);
  } else {
    console.log('Found', memberships?.length || 0, 'membership(s):');
    console.log(JSON.stringify(memberships, null, 2));
  }
}
