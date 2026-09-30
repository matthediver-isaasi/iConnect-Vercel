import pg from 'pg';

const databaseUrl = process.env.DEST_DATABASE_URL;

async function run() {
  const client = new pg.Client({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  console.log('Adding event_id column to discount_code table...');

  const queries = [
    `ALTER TABLE discount_code ADD COLUMN IF NOT EXISTS event_id UUID REFERENCES event(id) ON DELETE SET NULL`,
  ];

  for (const q of queries) {
    try {
      await client.query(q);
      console.log('OK:', q.substring(0, 80));
    } catch (err) {
      if (err.message.includes('already exists')) {
        console.log('Already exists, skipping:', q.substring(0, 80));
      } else {
        console.error('Error:', err.message, 'for query:', q.substring(0, 80));
      }
    }
  }

  console.log('Done!');
  await client.end();
}

run().catch(err => { console.error(err); process.exit(1); });
