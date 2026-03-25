import pg from 'pg';
const { Client } = pg;

async function run() {
  const client = new Client({ connectionString: process.env.DEST_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();

  console.log('Adding public transfer fields to booking_transfer_request...');

  const queries = [
    `ALTER TABLE booking_transfer_request ADD COLUMN IF NOT EXISTS target_email TEXT`,
    `ALTER TABLE booking_transfer_request ADD COLUMN IF NOT EXISTS target_first_name TEXT`,
    `ALTER TABLE booking_transfer_request ADD COLUMN IF NOT EXISTS target_last_name TEXT`,
    `ALTER TABLE booking_transfer_request ADD COLUMN IF NOT EXISTS target_organisation TEXT`,
    `ALTER TABLE booking_transfer_request ADD COLUMN IF NOT EXISTS target_phone TEXT`,
  ];

  for (const q of queries) {
    await client.query(q);
    console.log('  Done:', q.substring(0, 80));
  }

  // Make target_member_id nullable if it isn't already
  const colInfo = await client.query(`
    SELECT is_nullable FROM information_schema.columns
    WHERE table_name = 'booking_transfer_request' AND column_name = 'target_member_id'
  `);
  if (colInfo.rows.length > 0 && colInfo.rows[0].is_nullable === 'NO') {
    await client.query(`ALTER TABLE booking_transfer_request ALTER COLUMN target_member_id DROP NOT NULL`);
    console.log('  Made target_member_id nullable');
  } else {
    console.log('  target_member_id already nullable or does not exist');
  }

  console.log('Migration complete.');
  await client.end();
}

run().catch(err => { console.error(err); process.exit(1); });
