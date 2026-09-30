import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://lvmzliemqnieeoruhkik.supabase.co';
const supabaseKey = process.env.DEST_SUPABASE_KEY;

if (!supabaseKey) {
  console.error('DEST_SUPABASE_KEY is not set');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS audience_list (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  name TEXT NOT NULL,
  communication_category_id UUID REFERENCES communication_category(id),
  target_audiences JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audience_list_tenant_id ON audience_list(tenant_id);

ALTER TABLE audience_list ENABLE ROW LEVEL SECURITY;

CREATE POLICY "audience_list_all"
  ON audience_list FOR ALL
  USING (true) WITH CHECK (true);
`;

async function createTable() {
  console.log('Creating audience_list table...');

  const { data: check } = await supabase.from('audience_list').select('id').limit(1);
  if (check !== null) {
    console.log('Table already exists!');
    return;
  }

  const sqlRes = await fetch(`${supabaseUrl}/rest/v1/rpc/exec_sql`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': supabaseKey,
      'Authorization': `Bearer ${supabaseKey}`,
    },
    body: JSON.stringify({ sql: CREATE_SQL }),
  });

  if (sqlRes.ok) {
    console.log('Table created via RPC!');
  } else {
    console.log('RPC not available. Please create the table manually in the Supabase SQL Editor:');
    console.log(CREATE_SQL);
  }

  const { data: verify, error: verifyErr } = await supabase
    .from('audience_list')
    .select('id')
    .limit(1);

  if (verifyErr) {
    console.error('Table not yet accessible:', verifyErr.message);
  } else {
    console.log('Table verified - accessible via Supabase client');
  }
}

createTable().catch(console.error);
