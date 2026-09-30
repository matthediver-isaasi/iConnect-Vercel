import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://lvmzliemqnieeoruhkik.supabase.co';
const supabaseKey = process.env.DEST_SUPABASE_KEY;

if (!supabaseKey) {
  console.error('DEST_SUPABASE_KEY is not set');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS member_membership_override (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  member_id UUID NOT NULL,
  override_type TEXT NOT NULL CHECK (override_type IN ('structure', 'price', 'discount')),
  config_id UUID,
  band_id UUID,
  manual_price NUMERIC,
  discount_type TEXT CHECK (discount_type IS NULL OR discount_type IN ('percentage', 'fixed')),
  discount_value NUMERIC,
  membership_year TEXT,
  note TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (tenant_id, member_id, membership_year)
);

CREATE INDEX IF NOT EXISTS idx_member_membership_override_tenant_member
  ON member_membership_override (tenant_id, member_id);

ALTER TABLE member_membership_override ENABLE ROW LEVEL SECURITY;

CREATE POLICY "member_membership_override_all"
  ON member_membership_override FOR ALL
  USING (true) WITH CHECK (true);
`;

async function createTable() {
  console.log('Creating member_membership_override table...');

  const { data: check } = await supabase.from('member_membership_override').select('id').limit(1);
  if (check !== null) {
    console.log('Table already exists!');
    return;
  }

  const projectRef = supabaseUrl.replace('https://', '').replace('.supabase.co', '');
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
    .from('member_membership_override')
    .select('id')
    .limit(1);

  if (verifyErr) {
    console.error('Table not yet accessible:', verifyErr.message);
  } else {
    console.log('Table verified - accessible via Supabase client');
  }
}

createTable().catch(console.error);
