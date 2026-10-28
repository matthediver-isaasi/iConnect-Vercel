// Destination-only, verified TLS. Default is read-only; --apply changes schema,
// never template content. No SOURCE fallback.
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isApprovedDestinationSupabaseTarget, DESTINATION_PROJECT_REF } from './lib/destinationSupabaseTarget.mjs';

if (!isApprovedDestinationSupabaseTarget(process.env.DEST_DATABASE_URL, process.env.DEST_SUPABASE_URL)) {
  throw new Error('Refusing unverified destination');
}
const url = new URL(process.env.DEST_DATABASE_URL);
for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) url.searchParams.delete(key);
const response = await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt');
if (!response.ok) throw new Error('Public CA unavailable');
const db = new pg.Client({ connectionString: url.toString(), connectionTimeoutMillis: 15000,
  ssl: { rejectUnauthorized: true, ca: await response.text(), servername: url.hostname } });
const inspect = async () => (await db.query(`SELECT
  EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public'
    AND table_name='cpd_certificate_placeholder' AND column_name='text_template') AS column_present,
  pg_get_functiondef('public.save_cpd_certificate_template(uuid,uuid,integer,text,text,jsonb,text)'::regprocedure) AS definition,
  to_regprocedure('public.save_cpd_certificate_template_checked(uuid,uuid,integer,text,text,jsonb,text)') IS NOT NULL AS checked_save_present
`)).rows[0];
const summary = row => ({ columnPresent: row.column_present, checkedSavePresent: row.checked_save_present,
  insertProjection: row.definition.includes('text_template, sample_value'),
  selectProjection: row.definition.includes('field.text_template, field.sample_value'),
  recordsetProjection: row.definition.includes('text_template TEXT, sample_value TEXT'),
  functionSha256: createHash('sha256').update(row.definition).digest('hex') });
try {
  await db.connect();
  await db.query("SET statement_timeout='20s'; SET lock_timeout='5s'");
  console.log(JSON.stringify({ project: DESTINATION_PROJECT_REF, before: summary(await inspect()) }));
  if (process.argv.includes('--apply')) {
    for (const file of ['20261027_cpd_certificate_authored_text.sql', '20261028_cpd_certificate_checked_save.sql']) {
      const sql = await readFile(`supabase/migrations/${file}`, 'utf8');
      await db.query(sql);
      console.log(JSON.stringify({ applied: file, sha256: createHash('sha256').update(sql).digest('hex') }));
    }
  }
  console.log(JSON.stringify({ project: DESTINATION_PROJECT_REF, after: summary(await inspect()), templateContentChanged: false }));
} catch (error) {
  // Do not print connection properties or provider error objects.
  console.error(JSON.stringify({ error: 'Certificate schema operation failed', code: error.code || null }));
  process.exitCode = 1;
} finally { await db.end(); }
