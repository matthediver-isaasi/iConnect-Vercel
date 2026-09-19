import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import pg from 'pg';
import { historicalManifest, fingerprint, importHistoricalPilot, STRUCTURE_ID } from './bnms-dd-pilot-history.mjs';
import { TENANT_ID, MEMBER_ID, MANDATE_ID, MONTHS } from './bnms-dd-pilot.mjs';
import { parseHistoryArgs } from './run-bnms-dd-pilot-history.mjs';

const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function fixture() {
  return {
    member: { id: MEMBER_ID, tenant_id: TENANT_ID }, classes: [{ value: 'Full with NMC' }],
    invoices: MONTHS.map((period, i) => ({
      InvoiceID: uuid(i + 1), InvoiceNumber: `INV-${i}`, DateString: `${period}T00:00:00`,
      Type: 'ACCREC', Status: 'PAID', CurrencyCode: 'GBP', Total: 13.04,
      AmountPaid: 13.04, AmountDue: 0, AmountCredited: 0,
      Contact: { ContactID: '3e69cfdf-4d7c-4d70-9630-aa68f8c8fced' },
      Payments: [{ PaymentID: uuid(i + 101), Reference: `PM-${i}`, Amount: 13.04 }],
      LineItems: [{ AccountCode: '200' }],
    })),
    providerPayments: MONTHS.map((period, i) => ({
      id: `PM-${i}`, charge_date: period.replace(/01$/, '08'), status: 'paid_out',
      amount: 1304, amount_refunded: 0, currency: 'GBP',
      links: { mandate: MANDATE_ID, creditor: 'CR0000B50W1Y2R' },
      metadata: { 'Invoice number': `INV-${i}` },
    })),
  };
}

test('approved historical values remain 1304, future approval 1300; identities cannot switch', () => {
  const m = historicalManifest(fixture());
  assert.equal(m.approvedMonthlyAmountMinor, 1300);
  assert.equal(m.rows.length, 9);
  assert.equal(m.rows[0].charge_date, '2026-01-08');
  for (const change of [
    e => { e.member.id = uuid(100); },
    e => { e.member.tenant_id = uuid(100); },
    e => { e.invoices[0].AmountPaid = 0; e.invoices[0].AmountCredited = 13.04; },
    e => { e.providerPayments[0].amount_refunded = 1; },
    e => { e.providerPayments[0].status = 'failed'; },
    e => { e.invoices[0].LineItems[0].AccountCode = '210'; },
    e => { e.invoices[0].Payments[0].Reference = 'other'; },
    e => { e.invoices.pop(); },
    e => { e.invoices[0].InvoiceID = e.invoices[1].InvoiceID; },
  ]) {
    const e = fixture(); change(e); assert.throws(() => historicalManifest(e));
  }
});
test('runner flags reject identity overrides, unreviewed apply and unsafe report path', () => {
  for (const args of [
    ['--member', MEMBER_ID], ['--apply'], ['--resume'],
    ['--evidence', '/tmp/e', '--out', 'reports/e.json'],
    ['--migration', '--out', '/tmp/e'],
  ]) assert.throws(() => parseHistoryArgs(args));
  assert.equal(parseHistoryArgs(['--migration']).apply, false);
});

test('single Xero invoice may omit zero AmountCredited only with explicit full cash settlement', () => {
  const e = fixture();
  delete e.invoices[0].AmountCredited;
  assert.equal(historicalManifest(e).rows.length, 9);
  for (const change of [
    i => { delete i.AmountPaid; },
    i => { i.AmountPaid = 0; },
    i => { i.AmountPaid = 12; },
    i => { delete i.AmountDue; },
    i => { i.AmountDue = null; },
    i => { i.AmountDue = 1; },
    i => { i.CreditNotes = [{ CreditNoteID: uuid(900) }]; },
    i => { i.AmountCredited = 13.04; },
    i => { i.AmountCredited = null; },
  ]) {
    const changed = structuredClone(e);
    change(changed.invoices[0]);
    assert.throws(() => historicalManifest(changed), /Invoice evidence conflict/);
  }
});

test('disposable PostgreSQL: atomicity, constraints, failure/resume, replay and provider side-effect isolation', { timeout: 60000 }, async () => {
  const root = await mkdtemp(`${tmpdir()}/bnms-history-test-`);
  function run(command, args) {
    const r = spawnSync(command, args, { encoding: 'utf8', timeout: 15000 });
    assert.equal(r.status, 0, r.stderr); return r.stdout;
  }
  const data = `${root}/data`;
  let started = false; let client;
  try {
    run('initdb', ['-D', data, '--no-locale', '--encoding=UTF8', '--auth=trust', '-U', 'postgres']);
    run('pg_ctl', ['-D', data, '-l', `${root}/postgres.log`, '-o', `-k ${root} -h '' -p 5489`, '-w', 'start']);
    started = true;
    client = new pg.Client({ host: root, port: 5489, user: 'postgres', database: 'postgres' });
    await client.connect();
    await client.query(`
      CREATE TABLE member(id uuid PRIMARY KEY, tenant_id uuid);
      CREATE TABLE membership_tier_config(id uuid PRIMARY KEY, tenant_id uuid, is_active boolean,
        structure_scope_type text, structure_match_value text,currency text,dd_monthly_amount numeric);
      CREATE TABLE preference_field(id uuid PRIMARY KEY,tenant_id uuid,name text,entity_scope text,is_active boolean);
      CREATE TABLE member_preference_value(id uuid PRIMARY KEY,member_id uuid,field_id uuid,value text);
      CREATE TABLE gocardless_payments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),gocardless_payment_id text);
      CREATE TABLE member_membership_history(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,xero_invoice_id text,accounting_invoice_id text);
      INSERT INTO member VALUES('${MEMBER_ID}','${TENANT_ID}');
      INSERT INTO membership_tier_config VALUES('${STRUCTURE_ID}','${TENANT_ID}',true,'member','Full with NMC','GBP',13);
      INSERT INTO preference_field VALUES('${uuid(900)}','${TENANT_ID}','member_class','member',true);
      INSERT INTO member_preference_value VALUES('${uuid(901)}','${MEMBER_ID}','${uuid(900)}','Full with NMC');
    `);
    const sql = await readFile(new URL('../supabase/migrations/20261108_bnms_dd_pilot_history.sql', import.meta.url), 'utf8');
    await client.query(sql); await client.query(sql); // migration rerunnable
    const e = fixture();
    // Deferred completeness applies even to SQL callers bypassing the runner.
    await client.query('BEGIN');
    await client.query(`INSERT INTO bnms_dd_pilot_import
      (tenant_id,member_id,structure_id,mandate_id,customer_id,evidence_sha256,evidence)
      VALUES($1,$2,$3,$4,'CU00426EF15CE5',$5,'{}')`,
      [TENANT_ID, MEMBER_ID, STRUCTURE_ID, MANDATE_ID, 'a'.repeat(64)]);
    await assert.rejects(client.query('COMMIT'), /exactly nine/);
    await client.query('ROLLBACK');
    const dry = await importHistoricalPilot(client, e);
    assert.equal(dry.writes, 0);
    const options = { apply: true, reviewSha256: fingerprint(historicalManifest(e)), verifiedDestination: true };
    await assert.rejects(importHistoricalPilot(client, e, { ...options, reviewSha256: 'bad' }), /reviewed/);
    // Simulate a mid-batch database failure: parent and earlier rows must rollback.
    await client.query(`CREATE FUNCTION fail_third() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.period='2026-03-01' THEN RAISE EXCEPTION 'injected'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_third BEFORE INSERT ON bnms_dd_historical_payment FOR EACH ROW EXECUTE FUNCTION fail_third();`);
    await assert.rejects(importHistoricalPilot(client, e, options), /injected/);
    assert.equal((await client.query('SELECT count(*)::integer AS n FROM bnms_dd_pilot_import')).rows[0].n, 0);
    await client.query('DROP TRIGGER fail_third ON bnms_dd_historical_payment');
    const applied = await importHistoricalPilot(client, e, options);
    assert.equal(applied.writes, 10);
    const before = (await client.query('SELECT id,created_at FROM bnms_dd_historical_payment ORDER BY period')).rows;
    const replay = await importHistoricalPilot(client, e, options);
    assert.equal(replay.writes, 0);
    assert.deepEqual((await client.query('SELECT id,created_at FROM bnms_dd_historical_payment ORDER BY period')).rows, before);
    await assert.rejects(client.query("UPDATE bnms_dd_historical_payment SET amount_minor=1300"), /immutable/);
    await assert.rejects(client.query("INSERT INTO gocardless_payments(gocardless_payment_id) VALUES('PM-0')"), /mutable payment ledger/);
    await assert.rejects(client.query('INSERT INTO member_membership_history(xero_invoice_id) VALUES($1)', [uuid(1)]), /mutable membership ledger/);
    const wrongEvidence = fixture();
    wrongEvidence.invoices[0].InvoiceNumber = 'REPLACED';
    wrongEvidence.providerPayments[0].metadata['Invoice number'] = 'REPLACED';
    await assert.rejects(importHistoricalPilot(client, wrongEvidence, {
      ...options, reviewSha256: fingerprint(historicalManifest(wrongEvidence)),
    }), /immutable evidence differs/);
    assert.equal((await client.query('SELECT count(*)::integer AS n FROM gocardless_payments')).rows[0].n, 0);
    assert.equal((await client.query('SELECT count(*)::integer AS n FROM member_membership_history')).rows[0].n, 0);
  } finally {
    await client?.end();
    if (started) run('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
    await rm(root, { recursive: true, force: true });
  }
});