import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://lvmzliemqnieeoruhkik.supabase.co';
const supabaseKey = process.env.DEST_SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function createVatOverrideTable() {
  console.log('Creating membership_tier_vat_override table...');

  const { error } = await supabase.rpc('exec_sql', {
    sql: `
      CREATE TABLE IF NOT EXISTS membership_tier_vat_override (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        config_id UUID NOT NULL,
        tenant_id UUID NOT NULL,
        field_id UUID,
        field_label TEXT,
        match_value TEXT NOT NULL DEFAULT '',
        vat_rate TEXT,
        label TEXT,
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_vat_override_config_tenant 
        ON membership_tier_vat_override(config_id, tenant_id);

      ALTER TABLE membership_tier_vat_override ENABLE ROW LEVEL SECURITY;

      CREATE POLICY "membership_tier_vat_override_all" 
        ON membership_tier_vat_override FOR ALL 
        USING (true) WITH CHECK (true);
    `
  });

  if (error) {
    console.error('RPC error, trying direct approach:', error.message);
    
    const queries = [
      `CREATE TABLE IF NOT EXISTS membership_tier_vat_override (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        config_id UUID NOT NULL,
        tenant_id UUID NOT NULL,
        field_id UUID,
        field_label TEXT,
        match_value TEXT NOT NULL DEFAULT '',
        vat_rate TEXT,
        label TEXT,
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )`
    ];

    for (const sql of queries) {
      const { error: qErr } = await supabase.rpc('exec_sql', { sql });
      if (qErr) {
        console.error('Query error:', qErr.message);
      }
    }
  }

  const { data: testData, error: testErr } = await supabase
    .from('membership_tier_vat_override')
    .select('id')
    .limit(1);

  if (testErr) {
    console.error('Table verification failed:', testErr.message);
    console.log('The table may need to be created manually in Supabase dashboard.');
    console.log(`
SQL to run in Supabase SQL Editor:

CREATE TABLE IF NOT EXISTS membership_tier_vat_override (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  config_id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  field_id UUID,
  field_label TEXT,
  match_value TEXT NOT NULL DEFAULT '',
  vat_rate TEXT,
  label TEXT,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vat_override_config_tenant 
  ON membership_tier_vat_override(config_id, tenant_id);

ALTER TABLE membership_tier_vat_override ENABLE ROW LEVEL SECURITY;

CREATE POLICY "membership_tier_vat_override_all" 
  ON membership_tier_vat_override FOR ALL 
  USING (true) WITH CHECK (true);
    `);
  } else {
    console.log('Table membership_tier_vat_override exists and is accessible!');
  }
}

createVatOverrideTable().catch(console.error);
