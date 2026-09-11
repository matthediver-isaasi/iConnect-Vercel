import { readFile } from 'node:fs/promises';
import pg from 'pg';

if (!process.argv.includes('--apply')) {
  console.log('Dry run: would apply field-mapping workflow outbox atomic/security migrations to DEST_DATABASE_URL only.');
} else {
  if (!process.env.DEST_DATABASE_URL) {
    throw new Error('DEST_DATABASE_URL is required. No database was changed.');
  }
  const client = new pg.Client({ connectionString: process.env.DEST_DATABASE_URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '10s'");
    for (const file of [
      '20261021_form_due_diligence_field_mapping_outbox_atomic.sql',
      '20261022_form_due_diligence_field_mapping_outbox_preference_scope.sql',
    ]) {
      await client.query(await readFile(
        new URL(`../supabase/migrations/${file}`, import.meta.url),
        'utf8',
      ));
    }
    await client.query("NOTIFY pgrst, 'reload schema'");
    await client.query('COMMIT');
    console.log('Applied field-mapping workflow outbox atomic/security migrations');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}