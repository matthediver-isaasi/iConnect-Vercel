import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';

const sql = await readFile(new URL('../migrations/20261013_dynamic_directory_filter_expression.sql', import.meta.url), 'utf8');
const hash = createHash('sha256').update(sql).digest('hex');
const args = process.argv.slice(2);
if (!args.includes('--apply') && !args.includes('--preflight')) {
  console.log(JSON.stringify({ sha256: hash, applied: false, target: 'DEST only' }));
} else {
  if (args.includes('--apply') && !args.includes(`--review-sha256=${hash}`)) throw new Error('Reviewed SQL hash required');
  const target = destinationTarget(process.env);
  const response = await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt');
  if (!response.ok) throw new Error('Unable to obtain TLS CA');
  const client = new pg.Client({ connectionString: target.toString(), ssl: { ca: await response.text(), rejectUnauthorized: true, servername: target.hostname } });
  try {
    await client.connect();
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '10s'; SET LOCAL statement_timeout = '30s'");
    if (args.includes('--apply')) await client.query(sql);
    const { rows } = await client.query("SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='dynamic_directory' AND column_name='filter_expression'");
    if (args.includes('--apply') && rows[0]?.data_type !== 'jsonb') throw new Error('Column verification failed');
    await client.query('COMMIT');
    console.log(JSON.stringify({ project: 'lvmzliemqnieeoruhkik', target: 'DEST', verifiedTLS: true, applied: args.includes('--apply'), column: rows, sha256: hash }));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Directory migration failed:', error.code || error.name);
    process.exitCode = 1;
  } finally { await client.end(); }
}
