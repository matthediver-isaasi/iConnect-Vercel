import pg from 'pg';

async function createTable() {
  const connectionString = process.env.DEST_DATABASE_URL;
  if (!connectionString) {
    console.error('DEST_DATABASE_URL is not set');
    process.exit(1);
  }

  const client = new pg.Client({ connectionString });
  await client.connect();

  console.log('Creating booking_transfer_request table...');

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
  console.log('Table created successfully');
}

createTable().catch(err => {
  console.error('Failed to create table:', err);
  process.exit(1);
});
