import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://lvmzliemqnieeoruhkik.supabase.co';
const supabaseKey = process.env.DEST_SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function createTable() {
  console.log('Creating booking_transfer_request table...');
  
  const { error } = await supabase.rpc('exec_sql', {
    sql: `
      CREATE TABLE IF NOT EXISTS booking_transfer_request (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        booking_id uuid NOT NULL,
        event_id uuid,
        member_id uuid NOT NULL,
        target_member_id uuid NOT NULL,
        reason text,
        status text NOT NULL DEFAULT 'pending',
        reviewed_by text,
        reviewed_at timestamptz,
        review_notes text,
        created_at timestamptz DEFAULT now()
      );
      
      CREATE INDEX IF NOT EXISTS idx_btr_tenant_id ON booking_transfer_request(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_btr_booking_id ON booking_transfer_request(booking_id);
      CREATE INDEX IF NOT EXISTS idx_btr_member_id ON booking_transfer_request(member_id);
      CREATE INDEX IF NOT EXISTS idx_btr_target_member_id ON booking_transfer_request(target_member_id);
      CREATE INDEX IF NOT EXISTS idx_btr_status ON booking_transfer_request(status);
      CREATE INDEX IF NOT EXISTS idx_btr_tenant_status ON booking_transfer_request(tenant_id, status);
    `
  });

  if (error) {
    console.error('RPC exec_sql failed, trying direct SQL via pg...', error.message);
    
    const pg = await import('pg');
    const client = new pg.default.Client({ connectionString: process.env.DEST_DATABASE_URL });
    await client.connect();
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS booking_transfer_request (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        booking_id uuid NOT NULL,
        event_id uuid,
        member_id uuid NOT NULL,
        target_member_id uuid NOT NULL,
        reason text,
        status text NOT NULL DEFAULT 'pending',
        reviewed_by text,
        reviewed_at timestamptz,
        review_notes text,
        created_at timestamptz DEFAULT now()
      );
      
      CREATE INDEX IF NOT EXISTS idx_btr_tenant_id ON booking_transfer_request(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_btr_booking_id ON booking_transfer_request(booking_id);
      CREATE INDEX IF NOT EXISTS idx_btr_member_id ON booking_transfer_request(member_id);
      CREATE INDEX IF NOT EXISTS idx_btr_target_member_id ON booking_transfer_request(target_member_id);
      CREATE INDEX IF NOT EXISTS idx_btr_status ON booking_transfer_request(status);
      CREATE INDEX IF NOT EXISTS idx_btr_tenant_status ON booking_transfer_request(tenant_id, status);
    `);
    
    await client.end();
    console.log('Table created successfully via pg client');
    return;
  }

  console.log('Table created successfully via Supabase RPC');
}

createTable().catch(err => {
  console.error('Failed to create table:', err);
  process.exit(1);
});
