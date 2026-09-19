import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import pg from 'pg';

test('reminder claims serialize both owners, retain unpaid quotes and recover expiry on disposable PostgreSQL', { timeout: 120000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'reminder-fee-pg-'));
  const cluster = join(dir, 'data');
  const clients = [];
  let running = false;
  const connect = async () => { const db = new pg.Client({ host: dir, port: 55489, user: 'runner', database: 'postgres' });
    await db.connect(); clients.push(db); return db; };
  try {
    execFileSync('initdb', ['-D', cluster, '-A', 'trust', '-U', 'runner', '--no-locale'], { stdio: 'pipe' });
    execFileSync('pg_ctl', ['-D', cluster, '-l', join(dir, 'postgres.log'), '-o', `-k ${dir} -p 55489 -h ''`, '-w', 'start'], { stdio: 'pipe' });
    running = true;
    const db = await connect(), other = await connect();
    await db.query(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE member(id uuid, tenant_id uuid); CREATE TABLE organization(id uuid,tenant_id uuid);
      CREATE TABLE member_membership_history(member_id uuid,tenant_id uuid,membership_year text,payment_status text,paid_at timestamptz);
      CREATE TABLE organisation_membership_history(organization_id uuid,tenant_id uuid,membership_year text,payment_status text,paid_at timestamptz);`);
    await db.query(await readFile(new URL('../../supabase/migrations/20260919_atomic_member_fee_token_claim.sql', import.meta.url), 'utf8'));
    await db.query(await readFile(new URL('../../supabase/migrations/20261012_reminder_fee_token_claim.sql', import.meta.url), 'utf8'));
    const tenant = '00000000-0000-0000-0000-000000000001', owner = '00000000-0000-0000-0000-000000000002';
    await db.query('INSERT INTO member VALUES ($1,$2);', [owner, tenant]);
    await db.query('INSERT INTO organization VALUES ($1,$2);', [owner, tenant]);
    let sequence = 0;
    const claim = async (connection, member, year, snapshot = {}) => (await connection.query(
      "SELECT claim_reminder_fee_token($1,$2,$3,$4,$5,now()+interval '30 days',$6) AS claim",
      [tenant, member ? owner : null, member ? null : owner, year, `token-${sequence++}`,
        { final_cost: 120, currency: 'GBP', tier_label: 'Agreed',
          cost_breakdown: { renewalQuote: { membershipYear: { label: year } } }, ...snapshot }])).rows[0].claim;
    for (const member of [true, false]) {
      const year = member ? '2026-member' : '2026-org';
      const [a,b] = await Promise.all([claim(db, member, year), claim(other, member, year)]);
      assert.equal(a.id, b.id);
      assert.equal(a.token, b.token);
      assert.equal((await claim(db, member, year, { final_cost: 999 })).final_cost, 120);
      await db.query("UPDATE membership_fee_token SET expires_at=now()-interval '1 day' WHERE id=$1", [a.id]);
      const renewed = await claim(db, member, year, { final_cost: 999 });
      assert.notEqual(renewed.id, a.id);
      assert.equal(renewed.final_cost, 120);
      await db.query("UPDATE membership_fee_token SET status='paid' WHERE id=$1", [renewed.id]);
      assert.match((await claim(db, member, year)).error, /complete/);
    }
    const submitted = await claim(db, true, 'po');
    await db.query("UPDATE membership_fee_token SET status='po_submitted',expires_at=now()-interval '1 day' WHERE id=$1", [submitted.id]);
    assert.match((await claim(db, true, 'po')).error, /reconciliation/);
    const count = await db.query("SELECT count(*)::int AS count FROM membership_fee_token WHERE membership_year='2026-member'");
    assert.equal(count.rows[0].count, 2);
    const emailSnapshot = { preparation_mode: 'email', final_cost: 80, cost_breakdown: {} };
    const [emailA,emailB] = await Promise.all([
      claim(db, false, 'email-year', emailSnapshot), claim(other, false, 'email-year', emailSnapshot),
    ]);
    assert.equal(emailA.id, emailB.id);
    const refreshed = await claim(db, false, 'email-year', { ...emailSnapshot, final_cost: 90 });
    assert.equal(refreshed.id, emailA.id);
    assert.equal(refreshed.final_cost, 90);
    // Matching net amount alone is insufficient: grafting a new quote onto an
    // old VAT/breakdown would expose one total and charge another.
    const legacy = await claim(db, false, 'vat-year', { preparation_mode: 'email',
      final_cost: 100, cost_breakdown: { annualCost: 100, vatAmount: 0, totalWithVat: 100 } });
    const changedVat = await claim(db, false, 'vat-year', { final_cost: 100,
      cost_breakdown: { annualCost: 100, vatAmount: 20, totalWithVat: 120,
        renewalQuote: { membershipYear: { label: 'vat-year' } } } });
    assert.match(changedVat.error, /differs/);
    const afterVat = (await db.query('SELECT cost_breakdown FROM membership_fee_token WHERE id=$1',[legacy.id])).rows[0].cost_breakdown;
    assert.equal(afterVat.totalWithVat, 100);
    assert.equal(afterVat.renewalQuote, undefined);
    const matchingVat = await claim(db, false, 'vat-year', { final_cost: 100,
      cost_breakdown: { annualCost: 100, vatAmount: 0, totalWithVat: 100,
        renewalQuote: { membershipYear: { label: 'vat-year' } } } });
    assert.equal(matchingVat.id, legacy.id);
    const beforeInvoice = await claim(db, false, 'invoice-year');
    const linked = await claim(db, false, 'invoice-year', {
      history_record_id: '00000000-0000-0000-0000-000000000003', xero_invoice_id: 'invoice',
    });
    assert.equal(linked.id, beforeInvoice.id);
    assert.equal(linked.xero_invoice_id, 'invoice');
    assert.equal(linked.history_record_id, '00000000-0000-0000-0000-000000000003');
  } finally {
    await Promise.all(clients.map(db => db.end()));
    if (running) execFileSync('pg_ctl', ['-D', cluster, '-m', 'immediate', '-w', 'stop'], { stdio: 'pipe' });
    await rm(dir, { recursive: true, force: true });
  }
});