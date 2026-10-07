#!/usr/bin/env node
// Destination-only, reviewed, data-only migration. Never prints credentials.
import pg from 'pg';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';

const migration = '20261007160000_nmc_membership_report_permission.sql';
const sql = await readFile(new URL(`../supabase/migrations/${migration}`, import.meta.url), 'utf8');
const sha256 = createHash('sha256').update(sql).digest('hex');
const args = process.argv.slice(2);
assert.ok(args.every(arg => arg === '--apply' || arg === '--verify-rollback' || /^--review-sha256=[a-f0-9]{64}$/.test(arg)));
assert.ok(!(args.includes('--apply') && args.includes('--verify-rollback')));
if (!args.includes('--apply') && !args.includes('--verify-rollback')) {
  console.log(JSON.stringify({ migration, sha256, dryRun: true, writesPerformed: false }));
} else {
  assert.ok(args.includes(`--review-sha256=${sha256}`), 'Reviewed migration digest required');
  const target = destinationTarget(process.env);
  const caResponse = await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt');
  assert.ok(caResponse.ok, 'Provider CA unavailable');
  const client = new pg.Client({ connectionString: target.toString(),
    ssl: { rejectUnauthorized: true, ca: await caResponse.text(), servername: target.hostname } });
  try {
    await client.connect();
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query("SET LOCAL statement_timeout='30s'");
    await client.query('LOCK TABLE public.role_access_item IN SHARE ROW EXCLUSIVE MODE');
    const fingerprint = async () => (await client.query(`SELECT md5(coalesce(
      jsonb_agg(to_jsonb(r) ORDER BY id)::text, '')) AS value
      FROM public.role_access_item r WHERE item_key <> 'membership.nmc-membership-report'`)).rows[0].value;
    const before = await fingerprint();
    await client.query(sql);
    assert.equal(await fingerprint(), before, 'Unrelated permissions changed');
    const read = async () => (await client.query(`SELECT id,item_key,label,parent_id,is_active,display_order
      FROM public.role_access_item WHERE item_key='membership.nmc-membership-report'`)).rows;
    const first = await read();
    assert.equal(first.length, 1, 'Expected exactly one report permission');
    // A second execution must leave the inserted/existing row unchanged.
    await client.query(sql);
    assert.equal(JSON.stringify(await read()), JSON.stringify(first), 'Migration is not idempotent');
    await client.query(args.includes('--apply') ? 'COMMIT' : 'ROLLBACK');
    console.log(JSON.stringify({ migration, target: 'DEST lvmzliemqnieeoruhkik',
      committed: args.includes('--apply'), rollbackVerified: args.includes('--verify-rollback'),
      unrelatedPermissionsUnchanged: true, idempotent: true, permission: first[0] }));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`Migration failed (${error.code || 'verification error'}); credentials and row data withheld.`);
    process.exitCode = 1;
  } finally { await client.end(); }
}
