import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  'https://lvmzliemqnieeoruhkik.supabase.co',
  process.env.DEST_SUPABASE_KEY
);

async function run() {
  console.log('Dropping my_preferences_role_ids and my_organisation_role_ids from preference_field...');

  const { error: e1 } = await supabase.rpc('exec_sql', {
    query: `ALTER TABLE preference_field DROP COLUMN IF EXISTS my_preferences_role_ids;`
  });

  if (e1) {
    console.log('RPC exec_sql not available, trying direct SQL via pg...');
    const pg = await import('pg');
    const client = new pg.default.Client({ connectionString: process.env.DEST_DATABASE_URL });
    await client.connect();
    await client.query('ALTER TABLE preference_field DROP COLUMN IF EXISTS my_preferences_role_ids');
    await client.query('ALTER TABLE preference_field DROP COLUMN IF EXISTS my_organisation_role_ids');
    await client.end();
    console.log('Done (via pg).');
  } else {
    const { error: e2 } = await supabase.rpc('exec_sql', {
      query: `ALTER TABLE preference_field DROP COLUMN IF EXISTS my_organisation_role_ids;`
    });
    if (e2) {
      console.error('Failed to drop my_organisation_role_ids:', e2.message);
    } else {
      console.log('Done (via rpc).');
    }
  }
}

run().catch(err => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
