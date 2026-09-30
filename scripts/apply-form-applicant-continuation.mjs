import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';

export const migrationUrl = new URL('../migrations/20260924_form_applicant_continuation.sql', import.meta.url);

export async function main(args = process.argv.slice(2)) {
  const sql = await readFile(migrationUrl, 'utf8');
  const sha256 = createHash('sha256').update(sql).digest('hex');
  if (!args.length) {
    console.log(JSON.stringify({ applied: false, migration: migrationUrl.pathname.split('/').at(-1), sha256 }));
    return;
  }
  if (args.length !== 2 || !args.includes('--apply')
    || !args.includes(`--review-sha256=${sha256}`)) {
    throw new Error('Apply requires --apply and the exact --review-sha256 from the offline invocation.');
  }
  const target = destinationTarget(process.env);
  const response = await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt');
  if (!response.ok) throw new Error('Trusted destination certificate unavailable.');
  const ca = await response.text();
  const client = new pg.Client({
    connectionString: target.toString(),
    ssl: { ca, rejectUnauthorized: true, servername: target.hostname },
  });
  try {
    await client.connect();
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SET LOCAL statement_timeout = '60s'");
    await client.query(sql);
    const { rows } = await client.query(`
      SELECT p.proname, p.prosecdef
        AND has_function_privilege('service_role', p.oid, 'EXECUTE')
        AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
        AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
        AND NOT EXISTS (
          SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
          WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
        ) AS valid
      FROM pg_proc p WHERE p.oid IN (
        'public.bind_form_applicant_continuation(uuid,uuid,uuid,uuid,text)'::regprocedure,
        'public.bind_form_applicant_draft(uuid,uuid,text)'::regprocedure
      )
    `);
    if (rows.length !== 2 || rows.some(row => !row.valid)) throw new Error('Function authorization verification failed.');
    const { rows: security } = await client.query(`
      SELECT relrowsecurity
        AND NOT has_table_privilege('anon',oid,'SELECT')
        AND NOT has_table_privilege('authenticated',oid,'SELECT') AS valid
      FROM pg_class WHERE oid='public.form_applicant_continuation'::regclass
    `);
    if (security[0]?.valid !== true) throw new Error('Capability table authorization verification failed.');
    await client.query('COMMIT');
    console.log(JSON.stringify({ applied: true, project: 'lvmzliemqnieeoruhkik', sha256, functionsVerified: rows.length }));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error('Applicant continuation migration failed; no success confirmed. Check destination access and reviewed migration.');
    process.exitCode = 1;
  });
}