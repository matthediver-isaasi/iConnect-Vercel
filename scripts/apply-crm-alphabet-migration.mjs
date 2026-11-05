#!/usr/bin/env node
// Offline by default; explicit hash-pinned schema application to DEST only.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';

export async function main(args = process.argv.slice(2), env = process.env) {
  if (args.some(a => !['--apply','--verify-target'].includes(a) && !/^--review-sha256=[a-f0-9]{64}$/.test(a))) throw new Error('Invalid migration arguments');
  const sql = await readFile(new URL('../supabase/migrations/202611050001_crm_alphabet_metadata.sql',import.meta.url),'utf8');
  const sha256 = createHash('sha256').update(sql).digest('hex');
  if (!args.includes('--apply') && !args.includes('--verify-target')) {
    console.log(JSON.stringify({ sha256, writesPerformed:false })); return;
  }
  if (args.includes('--apply') && !args.includes(`--review-sha256=${sha256}`)) throw new Error('Reviewed hash mismatch');
  const target = destinationTarget(env);
  const response = await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt');
  if (!response.ok) throw new Error('Cannot load trusted destination CA');
  const ca = await response.text();
  if (!ca.includes('BEGIN CERTIFICATE')) throw new Error('Invalid destination CA');
  const db = new pg.Client({ connectionString:target.toString(),ssl:{ rejectUnauthorized:true,ca,servername:target.hostname } });
  try {
    await db.connect();
    await db.query(args.includes('--apply') ? 'BEGIN' : 'BEGIN READ ONLY');
    await db.query("SET LOCAL statement_timeout='30s'; SET LOCAL lock_timeout='5s'");
    const { rows } = await db.query(`SELECT table_name,column_name,data_type FROM information_schema.columns
      WHERE table_schema='public' AND (table_name,column_name) IN (
        ('member','tenant_id'),('member','first_name'),('member','last_name'),
        ('organization','tenant_id'),('organization','name'),('custom_object_relationship','target_record_id'))`);
    if (rows.length!==6 || rows.some(r=>r.column_name.endsWith('_id') && r.data_type!=='uuid')) throw new Error('Destination schema contract mismatch');
    if (args.includes('--apply')) {
      await db.query(sql.replace(/^BEGIN;\s*$/m,'').replace(/^COMMIT;\s*$/m,''));
      const check = await db.query(`SELECT has_function_privilege('service_role',oid,'EXECUTE')
        AND NOT has_function_privilege('anon',oid,'EXECUTE')
        AND NOT has_function_privilege('authenticated',oid,'EXECUTE')
        AND NOT EXISTS (SELECT 1 FROM aclexplode(coalesce(proacl,acldefault('f',proowner))) a
          WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS restricted
        FROM pg_proc WHERE oid='public.crm_alphabet_metadata(uuid,text,text,jsonb,jsonb)'::regprocedure`);
      if (check.rows[0]?.restricted!==true) throw new Error('Alphabet privilege check failed');
    }
    await db.query('COMMIT');
    console.log(JSON.stringify({ destination:'lvmzliemqnieeoruhkik', schemaVerified:true,
      applied:args.includes('--apply'),sha256,productionRecordsChanged:0 }));
  } catch(error) {
    await db.query('ROLLBACK').catch(()=>{});
    throw error;
  } finally { await db.end(); }
}
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  main().catch(()=>{ console.error('Alphabet migration did not complete; verify pinned destination access and the reviewed schema.'); process.exitCode=1; });
}
