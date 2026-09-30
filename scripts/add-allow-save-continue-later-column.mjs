import pg from 'pg';
const { Client } = pg;

async function run() {
  const client = new Client({
    connectionString: process.env.DEST_DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  await client.connect();
  console.log('Connected to database');

  const check = await client.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'form' AND column_name = 'allow_save_continue_later'"
  );
  if (check.rows.length === 0) {
    await client.query('ALTER TABLE form ADD COLUMN allow_save_continue_later boolean DEFAULT true');
    console.log('Added allow_save_continue_later column to form');
  } else {
    console.log('form.allow_save_continue_later already exists');
  }

  await client.end();
  console.log('Done');
}

run().catch(e => {
  console.error('Migration failed:', e);
  process.exit(1);
});
