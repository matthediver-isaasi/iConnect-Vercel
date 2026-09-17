import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import pg from 'pg';

test('fee quote migration keeps captured pricing immutable on isolated PostgreSQL', { timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rolling-fee-quote-pg-'));
  const cluster = join(directory, 'data');
  let running = false;
  let db;
  try {
    execFileSync('initdb', ['-D', cluster, '-A', 'trust', '-U', 'runner', '--no-locale'], { stdio: 'pipe' });
    execFileSync('pg_ctl', ['-D', cluster, '-l', join(directory, 'postgres.log'), '-o', `-k ${directory} -p 55483 -h ''`, '-w', 'start'], { stdio: 'pipe' });
    running = true;
    db = new pg.Client({ host: directory, port: 55483, user: 'runner', database: 'postgres' });
    await db.connect();
    await db.query(`CREATE TABLE membership_fee_token (
      id text PRIMARY KEY, tenant_id text, member_id text, organization_id text,
      membership_year text, final_cost numeric, currency text,
      cost_breakdown jsonb, history_record_id text, stripe_payment_intent_id text
    )`);
    const migration = await readFile(new URL('../../supabase/migrations/20260921_rolling_fee_quote_guard.sql', import.meta.url), 'utf8');
    await db.query(migration);
    await db.query(migration);
    await db.query(`INSERT INTO membership_fee_token VALUES (
      'rolling', 'tenant-a', 'member-a', NULL, 'rolling:2026-09-15', 240, 'GBP',
      '{"commitment":{"term_key":"rolling:2026-09-15","membership_renewal_date":"2027-09-15"},"totalWithVat":288,"vatAmount":48}',
      NULL, NULL, NULL
    ), ('fixed', 'tenant-a', 'member-a', NULL, '2026/2027', 240, 'GBP', '{}', NULL, NULL, NULL)`);
    await db.query(`UPDATE membership_fee_token SET
      stripe_payment_attempted_at=NOW(), stripe_payment_intent_id='pi-a', history_record_id='history-a'
      WHERE id='rolling'`);
    for (const change of [
      "final_cost=300", "currency='USD'", "member_id='another'",
      "membership_year='rolling:2026-10-15'",
      "cost_breakdown=jsonb_set(cost_breakdown,'{commitment,membership_renewal_date}','\"2027-10-15\"')",
      "cost_breakdown=jsonb_set(cost_breakdown,'{totalWithVat}','300')",
    ]) {
      await assert.rejects(() => db.query(`UPDATE membership_fee_token SET ${change} WHERE id='rolling'`), /cannot be changed/);
    }
    await db.query("UPDATE membership_fee_token SET final_cost=300 WHERE id='fixed'");
    const row = (await db.query("SELECT * FROM membership_fee_token WHERE id='rolling'")).rows[0];
    assert.equal(row.final_cost, '240');
    assert.equal(row.stripe_payment_intent_id, 'pi-a');
    assert.ok(row.stripe_payment_attempted_at);
  } finally {
    if (db) await db.end();
    if (running) execFileSync('pg_ctl', ['-D', cluster, '-m', 'immediate', '-w', 'stop'], { stdio: 'pipe' });
    await rm(directory, { recursive: true, force: true });
  }
});