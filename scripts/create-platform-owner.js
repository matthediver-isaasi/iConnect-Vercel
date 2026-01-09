import { createClient } from '@supabase/supabase-js';
import bcrypt from 'bcryptjs';

const supabaseUrl = process.env.DEV_SUPABASE_URL;
const supabaseKey = process.env.DEV_SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

const email = process.argv[2] || 'owner@iconn.app';
const password = process.argv[3] || 'platformadmin123';
const name = process.argv[4] || 'Platform Owner';

async function run() {
  console.log('=== Create Platform Owner Account ===\n');

  const { data: existing } = await supabase
    .from('platform_owner')
    .select('id, email')
    .eq('email', email.toLowerCase())
    .single();

  if (existing) {
    console.log('Platform owner already exists:', existing.email);
    console.log('To update password, delete the account first.');
    process.exit(0);
  }

  const password_hash = await bcrypt.hash(password, 10);

  const { data: owner, error } = await supabase
    .from('platform_owner')
    .insert({
      email: email.toLowerCase(),
      password_hash,
      name,
      is_active: true
    })
    .select()
    .single();

  if (error) {
    console.error('Failed to create platform owner:', error.message);
    process.exit(1);
  }

  console.log('✓ Platform owner created!');
  console.log('  Email:', owner.email);
  console.log('  Name:', owner.name);
  console.log('  Password:', password);
  console.log('\nLogin at: /platform/login');
}

run().catch(console.error);
