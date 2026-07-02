import pg from 'pg';

const connectionString = process.env.DEST_DATABASE_URL;
if (!connectionString) {
  console.error('DEST_DATABASE_URL is required');
  process.exit(1);
}

const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });

async function run() {
  await client.connect();
  console.log('Connected to database');

  await client.query(`
    ALTER TABLE email_campaign 
    ADD COLUMN IF NOT EXISTS is_test_mode BOOLEAN DEFAULT false;
  `);
  console.log('Ensured is_test_mode column exists on email_campaign');

  await client.end();
  console.log('Migration complete');
}

run().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
