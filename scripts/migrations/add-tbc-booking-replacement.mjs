// Task: TBC events — replace standard booking elements.
// Adds replace_booking_elements / booking_replacement_message /
// booking_replacement_cta_label to event and complex_event (DEST DB).
import pg from 'pg';
const { Client } = pg;

const destUrl = process.env.DEST_DATABASE_URL || process.env.DATABASE_URL;
if (!destUrl) {
  console.error('DEST_DATABASE_URL or DATABASE_URL is not set');
  process.exit(1);
}

const COLUMNS = [
  ['replace_booking_elements', 'BOOLEAN'],
  ['booking_replacement_message', 'TEXT'],
  ['booking_replacement_cta_label', 'TEXT'],
];

async function main() {
  const client = new Client({ connectionString: destUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    for (const table of ['event', 'complex_event']) {
      for (const [name, type] of COLUMNS) {
        await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${name} ${type}`);
      }
      const { rows } = await client.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = $1 AND column_name = ANY($2)`,
        [table, COLUMNS.map(([n]) => n)]
      );
      if (rows.length !== COLUMNS.length) {
        throw new Error(`${table}: expected ${COLUMNS.length} columns, found ${rows.length}`);
      }
      console.log(`${table}: columns present.`);
    }
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
