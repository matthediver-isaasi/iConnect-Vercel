import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://lvmzliemqnieeoruhkik.supabase.co';
const supabaseKey = process.env.DEST_SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function run() {
  console.log('Adding structure_scope_type column to membership_tier_config...');

  const { data: test, error: testErr } = await supabase
    .from('membership_tier_config')
    .select('structure_scope_type')
    .limit(1);

  if (!testErr) {
    console.log('Column already exists, checking values...');
    const { data: configs } = await supabase
      .from('membership_tier_config')
      .select('id, structure_scope_type')
      .is('structure_scope_type', null);
    
    if (configs && configs.length > 0) {
      console.log(`Backfilling ${configs.length} rows with 'organization'...`);
      for (const cfg of configs) {
        await supabase
          .from('membership_tier_config')
          .update({ structure_scope_type: 'organization' })
          .eq('id', cfg.id);
      }
      console.log('Backfill complete.');
    } else {
      console.log('All rows already have structure_scope_type set.');
    }
    return;
  }

  console.log('Column does not exist. Adding via RPC...');
  const { error: rpcErr } = await supabase.rpc('exec_sql', {
    query: `ALTER TABLE membership_tier_config ADD COLUMN IF NOT EXISTS structure_scope_type text DEFAULT 'organization';`
  });

  if (rpcErr) {
    console.log('RPC not available, trying direct SQL via REST...');
    console.log('Please add the column manually in Supabase SQL editor:');
    console.log(`ALTER TABLE membership_tier_config ADD COLUMN IF NOT EXISTS structure_scope_type text DEFAULT 'organization';`);
    console.log('');
    console.log('Alternatively, we can work without the column and handle it at the application level.');
  } else {
    console.log('Column added successfully.');
  }
}

run().catch(console.error);
