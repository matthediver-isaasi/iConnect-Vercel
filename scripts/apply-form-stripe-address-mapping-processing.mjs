import { readFile } from 'node:fs/promises';
import pg from 'pg';

const files = ['20261017_form_stripe_address_mapping_processing.sql'];
if (!process.argv.includes('--apply')) {
  console.log(`Dry run: would apply ${files.join(', ')} to DEST_DATABASE_URL only.`);
} else {
  if (!process.env.DEST_DATABASE_URL) throw new Error('DEST_DATABASE_URL is required. No database was changed.');
  const client = new pg.Client({ connectionString: process.env.DEST_DATABASE_URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '10s'");
    for (const file of files) {
      await client.query(await readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8'));
      console.log(`Applied ${file}`);
    }
    await client.query("NOTIFY pgrst, 'reload schema'");
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}