import pg from 'pg';
const { Client } = pg;

async function run() {
  const client = new Client({
    connectionString: process.env.DEST_DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  await client.connect();
  console.log('Connected to database');

  const checkCE = await client.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'complex_event' AND column_name = 'is_featured'"
  );
  if (checkCE.rows.length === 0) {
    await client.query('ALTER TABLE complex_event ADD COLUMN is_featured boolean DEFAULT false');
    console.log('Added is_featured column to complex_event');
  } else {
    console.log('complex_event.is_featured already exists');
  }

  const checkE = await client.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'event' AND column_name = 'is_featured'"
  );
  if (checkE.rows.length === 0) {
    await client.query('ALTER TABLE event ADD COLUMN is_featured boolean DEFAULT false');
    console.log('Added is_featured column to event');
  } else {
    console.log('event.is_featured already exists');
  }

  await client.end();
  console.log('Done');
}

run().catch(e => {
  console.error('Migration failed:', e);
  process.exit(1);
});
