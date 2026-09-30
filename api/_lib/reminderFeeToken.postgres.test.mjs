import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { recordSucceededMembershipPaymentIntent } from './membershipPaymentReconciliation.js';

// Translate the recorder's small PostgREST surface to real SQL. In particular,
// no in-memory double can bypass the historical accounting-status CHECK.
function sqlClient(connection) {
  const identifier = value => {
    assert.match(value, /^[a-z_][a-z_0-9]*$/);
    return `"${value}"`;
  };
  return { from(table) {
    const filters = [], values = [];
    let operation = 'select', payload;
    const parameter = value => { values.push(value); return `$${values.length}`; };
    const execute = async single => {
      try {
        const where = filters.length ? ` WHERE ${filters.join(' AND ')}` : '';
        let sql = `SELECT * FROM ${identifier(table)}${where}`;
        if (operation === 'insert') {
          const entries = Object.entries(payload);
          sql = `INSERT INTO ${identifier(table)} (${entries.map(([key]) => identifier(key)).join(',')})
            VALUES (${entries.map(([, value]) => parameter(value)).join(',')}) RETURNING *`;
        } else if (operation === 'update') {
          sql = `UPDATE ${identifier(table)} SET ${Object.entries(payload)
            .map(([key, value]) => `${identifier(key)}=${parameter(value)}`).join(',')}${where} RETURNING *`;
        }
        const result = await connection.query(sql, values);
        return { data: single ? result.rows[0] || null : result.rows, error: null };
      } catch (error) { return { data: null, error }; }
    };
    const query = {
      select() { return query; },
      eq(key, value) { filters.push(`${identifier(key)}=${parameter(value)}`); return query; },
      or(expression) {
        filters.push(`(${expression.split(',').map(part => {
          const [key, operator, ...rest] = part.split('.');
          const value = rest.join('.');
          if (operator === 'is' && value === 'null') return `${identifier(key)} IS NULL`;
          assert.ok(['eq', 'neq'].includes(operator));
          return `${identifier(key)}${operator === 'eq' ? '=' : '<>'}${parameter(value)}`;
        }).join(' OR ')})`);
        return query;
      },
      insert(value) { operation = 'insert'; payload = value; return query; },
      update(value) { operation = 'update'; payload = value; return query; },
      maybeSingle() { return execute(true); },
      then(resolve, reject) { return execute(false).then(resolve, reject); },
    };
    return query;
  } };
}

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
    await db.query(await readFile(new URL('../../supabase/migrations/20260528_membership_accounting_sync_status.sql', import.meta.url), 'utf8'));
    for (const table of ['member_membership_history', 'organisation_membership_history']) {
      await db.query(`ALTER TABLE ${table}
        ADD COLUMN id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        ADD COLUMN stripe_payment_intent_id text,
        ADD COLUMN final_cost numeric, ADD COLUMN currency text,
        ADD COLUMN vat_amount numeric, ADD COLUMN total_with_vat numeric,
        ADD COLUMN purchase_order_number text, ADD COLUMN payment_method text,
        ADD COLUMN status text, ADD COLUMN notes text,
        ADD COLUMN term_start_date text, ADD COLUMN term_end_date text,
        ADD COLUMN scheduled_activation_date text, ADD COLUMN annual_renewal_state text,
        ADD COLUMN config_id text, ADD COLUMN billing_period text,
        ADD COLUMN tier_label text, ADD COLUMN annual_cost numeric,
        ADD COLUMN accounting_provider text, ADD COLUMN accounting_invoice_id text,
        ADD COLUMN accounting_invoice_number text,
        ADD COLUMN xero_invoice_id text, ADD COLUMN xero_invoice_number text`);
    }
    await db.query(await readFile(new URL('../../supabase/migrations/20260919_atomic_member_fee_token_claim.sql', import.meta.url), 'utf8'));
    await db.query(await readFile(new URL('../../supabase/migrations/20261012_reminder_fee_token_claim.sql', import.meta.url), 'utf8'));
    const identityMigration = await readFile(new URL('../../supabase/migrations/20261013_fee_token_invoice_identity.sql', import.meta.url), 'utf8');
    const accountingMigration = await readFile(new URL('../../supabase/migrations/20261115_reminder_accounting_completion.sql', import.meta.url), 'utf8');
    for (let pass = 0; pass < 2; pass++) {
      await db.query('BEGIN');
      await db.query(identityMigration);
      await db.query(accountingMigration);
      await db.query('COMMIT');
    }
    const tenant = '00000000-0000-0000-0000-000000000001', owner = '00000000-0000-0000-0000-000000000002';
    await db.query('INSERT INTO member VALUES ($1,$2);', [owner, tenant]);
    await db.query('INSERT INTO organization VALUES ($1,$2);', [owner, tenant]);
    const journalInsert = (connection, historyId, intent, journalTenant = tenant) => connection.query(
      'INSERT INTO membership_reminder_accounting(tenant_id,history_record_id,provider,stripe_payment_intent_id) VALUES($1,$2,$3,$4)',
      [journalTenant, historyId, 'quickbooks', intent]);
    const historyA = '00000000-0000-0000-0000-000000000003';
    const historyB = '00000000-0000-0000-0000-000000000004';
    const concurrentJournal = await Promise.allSettled([
      journalInsert(db, historyA, 'pi_journal'), journalInsert(other, historyA, 'pi_journal'),
    ]);
    assert.equal(concurrentJournal.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(concurrentJournal.find(result => result.status === 'rejected').reason.code, '23505');
    await assert.rejects(journalInsert(db, historyA, 'pi_other'), { code: '23505' });
    await assert.rejects(journalInsert(db, historyB, 'pi_journal'), { code: '23505' });
    // Tenant identity scopes both uniqueness constraints.
    await journalInsert(db, historyA, 'pi_journal', '00000000-0000-0000-0000-000000000005');
    await assert.rejects(db.query("INSERT INTO membership_reminder_accounting(tenant_id,history_record_id,provider,stripe_payment_intent_id) VALUES($1,$2,'unknown','pi_invalid')",
      [tenant, historyB]), { code: '23514' });
    const security = (await db.query(`SELECT relrowsecurity,
      has_table_privilege('anon','membership_reminder_accounting','SELECT') AS anon_read,
      has_table_privilege('authenticated','membership_reminder_accounting','INSERT') AS authenticated_write
      FROM pg_class WHERE oid='membership_reminder_accounting'::regclass`)).rows[0];
    assert.equal(security.relrowsecurity, true);
    assert.equal(security.anon_read, false);
    assert.equal(security.authenticated_write, false);
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
    for (const member of [true, false]) {
      const year = `qbo-${member}`;
      const snapshot = { accounting_provider: 'quickbooks', accounting_invoice_id: '123',
        accounting_invoice_number: 'QBO-123', history_record_id: '00000000-0000-0000-0000-000000000003' };
      const [first, parallel] = await Promise.all([claim(db, member, year, snapshot), claim(other, member, year, snapshot)]);
      assert.equal(first.id, parallel.id);
      assert.equal(first.accounting_invoice_id, '123');
      assert.equal(first.xero_invoice_id, null);
      assert.match((await claim(db, member, year, { ...snapshot, accounting_invoice_id: '456' })).error, /differs/);
      await db.query("UPDATE membership_fee_token SET expires_at=now()-interval '1 day' WHERE id=$1", [first.id]);
      const renewed = await claim(db, member, year, snapshot);
      assert.notEqual(renewed.id, first.id);
      assert.equal(renewed.accounting_provider, 'quickbooks');
      assert.equal(renewed.accounting_invoice_id, '123');
      await db.query("UPDATE membership_fee_token SET status='po_submitted' WHERE id=$1", [renewed.id]);
      const submittedAgain = await claim(db, member, year, { ...snapshot, preparation_mode: 'email', final_cost: 999 });
      assert.equal(submittedAgain.id, renewed.id);
      assert.equal(submittedAgain.final_cost, 120);
    }
    // Exercise the actual recorder against the prior production CHECKs, for
    // both marking existing history paid and reconstructing missing history.
    for (const member of [true, false]) for (const reconstruct of [false, true]) {
      const table = member ? 'member_membership_history' : 'organisation_membership_history';
      const column = member ? 'member_id' : 'organization_id';
      const year = `sync-${member}-${reconstruct}`;
      const intent = `pi_sync_${member}_${reconstruct}`;
      const reference = { provider: member ? 'quickbooks' : 'xero', invoiceId: `invoice-${year}` };
      const token = await claim(db, member, year, {
        cost_breakdown: { totalWithVat: 120, renewalQuote: {
          config: { id: 'config', billing_period: 'annual' },
          membershipYear: { label: year, start: '2099-01-01', end: '2099-12-31' },
        } },
      });
      if (!reconstruct) await db.query(
        `INSERT INTO ${table}(tenant_id,${column},membership_year,payment_status,total_with_vat,currency)
         VALUES($1,$2,$3,'unpaid',120,'GBP')`, [tenant, owner, year]);
      const paymentIntent = { id: intent, status: 'succeeded', amount: 12000, currency: 'gbp',
        metadata: { tenant_id: tenant, [column]: owner, membership_year: year, token_id: token.id } };
      let attempts = 0, workflows = 0;
      const readHistory = async () => (await db.query(
        `SELECT * FROM ${table} WHERE tenant_id=$1 AND membership_year=$2`, [tenant, year])).rows[0];
      const run = () => recordSucceededMembershipPaymentIntent({ tenantId: tenant, paymentIntent }, {
        db: sqlClient(db),
        fireWorkflow: async () => { workflows++; return { fired: true }; },
        completeReminderAccounting: async () => {
          const row = await readHistory();
          assert.equal(row.payment_status, 'paid');
          assert.equal(row.status, 'scheduled');
          assert.equal(row.accounting_sync_status, attempts === 0 ? 'retrying' : 'failed');
          if (++attempts === 1) throw new Error('Transient accounting outage');
          return { reference, payment_recorded: true };
        },
      });
      assert.equal((await run()).status, 'accounting-pending');
      assert.equal((await readHistory()).accounting_sync_status, 'failed');
      assert.equal((await run()).status, 'recorded');
      assert.equal((await readHistory()).accounting_sync_status, null);
      assert.equal((await readHistory()).accounting_sync_error, null);
      assert.equal((await run()).status, 'already-recorded');
      assert.equal(attempts, 2);
      assert.equal(workflows, 1);
      // Ensure these are real historical constraints, not a permissive fixture.
      for (const invalid of ['pending', 'synced']) {
        await assert.rejects(db.query(`UPDATE ${table} SET accounting_sync_status=$1 WHERE membership_year=$2`,
          [invalid, year]), { code: '23514' });
      }
    }
  } finally {
    await Promise.all(clients.map(db => db.end()));
    if (running) execFileSync('pg_ctl', ['-D', cluster, '-m', 'immediate', '-w', 'stop'], { stdio: 'pipe' });
    await rm(dir, { recursive: true, force: true });
  }
});