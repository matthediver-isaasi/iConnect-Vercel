import pg from 'pg';

const databaseUrl = process.env.DEST_DATABASE_URL;

async function run() {
  const client = new pg.Client({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  console.log('Making member_id nullable on booking_cancellation_request...');

  const queries = [
    `ALTER TABLE booking_cancellation_request ALTER COLUMN member_id DROP NOT NULL`,
  ];

  for (const q of queries) {
    try {
      await client.query(q);
      console.log('OK:', q);
    } catch (err) {
      console.error('Error:', err.message, 'for query:', q);
    }
  }

  console.log('Done!');
  await client.end();
}

run().catch(err => { console.error(err); process.exit(1); });
