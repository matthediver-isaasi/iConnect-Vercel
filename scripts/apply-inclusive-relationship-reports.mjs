/**
 * Destination-only setup for inclusive reports. Default: no writes.
 * node scripts/apply-inclusive-relationship-reports.mjs --apply
 * Requires DEST_DATABASE_URL; never falls back to SOURCE or DATABASE_URL.
 * Applies generic helpers and the independently named BNMS saved summary.
 */
import { readFile } from 'node:fs/promises';
import pg from 'pg';

const files = [
  '20261010_custom_object_report_summary.sql',
  '20261010_bnms_organisation_department_summary.sql',
];
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
    console.log('Inclusive report setup committed. Existing reports and membership records preserved.');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}