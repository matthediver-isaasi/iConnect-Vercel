import pg from 'pg';
const { Client } = pg;

async function run() {
  const client = new Client({ connectionString: process.env.DEST_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();

  console.log('Making member_id nullable on booking_transfer_request...');

  const colInfo = await client.query(`
    SELECT is_nullable FROM information_schema.columns
    WHERE table_name = 'booking_transfer_request' AND column_name = 'member_id'
  `);

  if (colInfo.rows.length > 0 && colInfo.rows[0].is_nullable === 'NO') {
    await client.query(`ALTER TABLE booking_transfer_request ALTER COLUMN member_id DROP NOT NULL`);
    console.log('  Done: member_id is now nullable');
  } else {
    console.log('  member_id is already nullable or does not exist');
  }

  console.log('Migration complete.');
  await client.end();
}

run().catch(err => { console.error(err); process.exit(1); });
