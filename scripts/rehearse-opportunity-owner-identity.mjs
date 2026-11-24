#!/usr/bin/env node
// No commit mode: live installation requires separate owner approval.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';

export const migrationName = '202701240001_opportunity_owner_identity.sql';
const caUrl = 'https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt';
const guard = 'public.guard_opportunity_tenant_links()';
const normalize = value => value.replace(/\s+/g, ' ').trim();

export function expectedGuard(source) {
  let result = source;
  for (const field of ['owner_id', 'principal_id']) {
    const old = `(SELECT 1 FROM tenant_user WHERE id=NEW.${field} AND tenant_id=NEW.tenant_id)`;
    assert.equal(result.split(old).length, 2, 'Guard contract changed; inspect before proceeding');
    result = result.replace(old, `(SELECT 1 FROM tenant_user WHERE id=NEW.${field} AND tenant_id=NEW.tenant_id
       UNION ALL
       SELECT 1 FROM tenant_identity i JOIN tenant_membership m ON m.identity_id=i.id
       WHERE i.id=NEW.${field} AND m.tenant_id=NEW.tenant_id AND m.status='active'
         AND (m.role IN ('owner','admin') OR m.membership_type='owner'))`);
  }
  return result;
}

export async function guardState(db) {
  const { rows } = await db.query(`SELECT p.prosrc source, p.prosecdef, p.proconfig, p.proacl::text,
    p.proowner, p.provolatile, p.prorettype FROM pg_proc p WHERE p.oid=$1::regprocedure`, [guard]);
  assert.equal(rows.length, 1);
  const triggers = (await db.query(`SELECT c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid) definition
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
    WHERE t.tgfoid=$1::regprocedure AND NOT t.tgisinternal ORDER BY c.relname,t.tgname`, [guard])).rows;
  assert.deepEqual(triggers.map(t => [t.relname, t.tgenabled]), [
    ['opportunity', 'O'], ['opportunity_activity', 'O'],
    ['opportunity_collaborator', 'O'], ['opportunity_contact_role', 'O'],
  ], 'Guard trigger attachments changed');
  return { ...rows[0], triggers };
}

export async function rehearse(db, mode, sql, original) {
  await db.query(mode === '--rehearse' ? 'BEGIN' : 'BEGIN READ ONLY');
  try {
    await db.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'");
    const before = await guardState(db);
    assert.equal(before.prosecdef, false);
    assert.deepEqual(before.proconfig, ['search_path=public']);
    const expected = expectedGuard(original);
    if (mode === '--verify') {
      assert.equal(normalize(before.source), normalize(expected), 'Installed guard differs from reviewed patch');
    } else {
      assert.equal(normalize(before.source), normalize(original), 'Deployed guard differs from inspected baseline');
      if (mode === '--rehearse') {
        await db.query(sql);
        const after = await guardState(db);
        assert.equal(normalize(after.source), normalize(expected));
        assert.deepEqual({ ...after, source: null }, { ...before, source: null },
          'Unrelated function metadata or trigger attachments changed');
      }
    }
    await db.query('ROLLBACK');
    // Verify rollback itself, not just that ROLLBACK returned.
    if (mode === '--rehearse') {
      await db.query('BEGIN READ ONLY');
      try {
        assert.deepEqual(await guardState(db), before, 'Rehearsal rollback did not restore the original guard');
      } finally { await db.query('ROLLBACK'); }
    }
    return { mode, rolledBack: true, applied: false };
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

export async function main(args = process.argv.slice(2), env = process.env) {
  assert.ok(args.length === 0 || (args.length === 2
    && ['--preflight', '--rehearse', '--verify'].includes(args[0])
    && /^--review-sha256=[a-f0-9]{64}$/.test(args[1])),
  'Use no arguments for offline review, or --preflight/--rehearse/--verify with --review-sha256=<hash>. No apply mode.');
  const sql = await readFile(new URL(`../supabase/migrations/${migrationName}`, import.meta.url), 'utf8');
  const baseline = await readFile(new URL('../supabase/migrations/20260908_opportunity_pipeline.sql', import.meta.url), 'utf8');
  const original = baseline.match(/CREATE OR REPLACE FUNCTION public\.guard_opportunity_tenant_links\(\)[\s\S]*?AS \$\$([\s\S]*?)END \$\$;/)?.[1];
  assert.ok(original, 'Missing baseline guard');
  const source = `${original}END `;
  const sha256 = createHash('sha256').update(sql).digest('hex');
  if (!args.length) return console.log(JSON.stringify({ migrationName, sha256, offline: true, applied: false }));
  assert.equal(args[1], `--review-sha256=${sha256}`, 'Reviewed migration hash mismatch');
  const target = destinationTarget(env);
  const response = await fetch(caUrl, { signal: AbortSignal.timeout(15000) });
  assert.ok(response.ok, 'Unable to obtain destination CA');
  const ca = await response.text();
  assert.ok(ca.includes('BEGIN CERTIFICATE'));
  const db = new pg.Client({ connectionString: target.toString(),
    ssl: { rejectUnauthorized: true, ca, servername: target.hostname },
    connectionTimeoutMillis: 15000 });
  try {
    await db.connect();
    console.log(JSON.stringify(await rehearse(db, args[0], sql, source)));
  } finally { await db.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    // Provider errors can include connection strings; do not print them.
    console.error('Opportunity identity check failed; no commit was attempted. Check target access and reviewed guard contract.');
    process.exitCode = 1;
  });
}
