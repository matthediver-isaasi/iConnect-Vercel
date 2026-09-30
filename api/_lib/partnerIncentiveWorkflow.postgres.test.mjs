// Isolated executable workflow regression: no application DB, providers or mail.
// Uses installed PostgreSQL binaries and a disposable Unix-socket-only cluster.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { membershipIncentiveSnapshot, incentiveFieldsFromSavedQuote } from './membershipIncentiveSnapshot.js';
import { historyFromFormPaymentSnapshot } from './formMembershipPaymentQuote.js';
import { workflowRollingCommitment, hasRollingMonthlyArrangement } from './rollingFeeCommitment.js';
import { validateWorkflowOrganizationMembershipSimulation } from './workflowMembershipSimulation.js';
import { calculateOriginalIncentiveRollover } from './membershipSimulationCore.js';
import { runAnnualOwnerRow, selectAnnualOwnerSettings } from './annualOwnerRenewalPipeline.js';

const src = readFileSync(new URL('./workflows.js', import.meta.url), 'utf8');
const body = src.slice(src.indexOf('async function executeCreateMembershipAction('),
  src.indexOf('async function executeCreateMemberMembership('))
  .replaceAll("await import('./membershipAddons.js')", 'mocks.addons')
  .replaceAll("await import('./accountingProvider.js')", 'mocks.accounting')
  .replaceAll("await import('./membershipNominalCode.js')", 'mocks.nominal')
  .replaceAll("await import('./invoiceAddressResolver.js')", 'mocks.address')
  .replaceAll("await import('./membershipInvoiceEmail.js')", 'mocks.email');
const simulation = () => ({
  success: true, org: { id: 'org', name: 'Partner test' },
  config: { id: 'joining', start_mode: 'fixed_date', billing_period: 'annual', pricing_model: 'flat',
    currency: 'GBP', rollover_enabled: true, free_period_unit: 'percent', free_period_amount: 40 },
  membershipYear: { label: '2026/2027', start: '2026-08-01', end: '2027-07-31' },
  yearNumber: 1, annualCost: 1, finalCost: 1, vatAmount: .2, vatRatePercent: 20, totalWithVat: 1.2,
  taxType: 'OUTPUT2', currency: 'GBP', overrideApplied: true, overrideType: 'price', freeDiscount: 0,
});

function harness(client, { yearMode, fallbackMode, approved = true, existing = false } = {}) {
  const sim = simulation(), inserts = [], invoices = [], emails = [];
  if (existing) sim.existingRecord = { id: 'existing' };
  const db = { from(table) {
    let fields, value, operation, filters = {};
    const q = {
      select(s) { fields = s; return q; }, eq(k, v) { filters[k] = v; return q; },
      is(k, v) { filters[k] = v; return q; },
      insert(v) { value = v; operation = 'insert'; return q; },
      update(v) { operation = 'update'; return q; },
      single() { return q; }, maybeSingle() { return q; },
      then(resolve, reject) {
        return (async () => {
          if (operation === 'insert') {
            assert.equal(table, 'organisation_membership_history');
            // jsonb_populate_record ignores unrelated invoice/display columns, but
            // all actual commitment columns are inserted into the real constraint.
            try {
              await client.query('INSERT INTO organisation_membership_history SELECT * FROM jsonb_populate_record(NULL::organisation_membership_history, $1::jsonb)', [JSON.stringify(value)]);
            } catch (error) { return { data: null, error }; }
            inserts.push(value);
            return { data: { ...value, id: 'new' }, error: null };
          }
          if (operation === 'update') return { data: null, error: null };
          if (table === 'system_settings') return { data: { setting_value: 'true' }, error: null };
          if (table === 'organisation_membership_history') return { data: { id: 'existing', final_cost: 1 }, error: null };
          if (table === 'organisation_membership_invoicing') {
            if (fields === 'fees_approved') return { data: { fees_approved: approved }, error: null };
            const mode = filters.membership_year === null ? fallbackMode : yearMode;
            return { data: mode ? { invoicing_mode: mode, invoice_date: '2026-10-01' } : null, error: null };
          }
          throw new Error(`Unexpected isolated read: ${table}`);
        })().then(resolve, reject);
      },
    }; return q;
  } };
  const mocks = {
    addons: { loadAddonLines: async () => [], computeAddonTotals: () => ({}),
      buildExtraLineItems: () => [], processTrainingFundAddons: async () => {} },
    accounting: { getAccountingProvider: async () => ({ name: 'xero', createMembershipInvoice: async args => {
      assert.equal(inserts.length, 1, 'invoice must follow successful constrained insert');
      invoices.push(args); return { invoice_id: 'mock-only', invoice_number: 'MOCK' };
    } }), buildInvoiceColumnUpdate: () => ({ accounting_invoice_id: 'mock-only' }) },
    nominal: { resolveMembershipNominalCode: async () => '4020' },
    address: { resolveInvoiceAddress: async () => ({}) },
    email: { sendMembershipInvoiceEmail: async args => { emails.push(args); return { success: true }; } },
  };
  const deps = {
    mocks, supabase: db, simulateMembershipForOrg: async () => sim,
    membershipIncentiveSnapshot, workflowRollingCommitment, hasRollingMonthlyArrangement,
    validateWorkflowOrganizationMembershipSimulation, autoApproveOrgFees: async () => ({ approved: false }),
    isZeroDueMembership: () => false, isZeroDueExistingMembership: () => false,
    resolveInvoiceAddress: async () => ({}),
    membershipInvoiceDeliveryActionState: invoice => ({ status: invoice ? 'success' : 'partial' }),
    console: { log() {}, error() {} },
  };
  const run = new Function(...Object.keys(deps), `${body}; return executeCreateMembershipAction;`)(...Object.values(deps));
  return { inserts, invoices, emails, run: () => run({}, { tenant_id: 'tenant', name: 'Test' }, 'organization', 'org', {}) };
}

test('Partner workflow with real rolling completeness constraints and isolated effects', async t => {
  const bin = dirname(execFileSync('which', ['postgres'], { encoding: 'utf8' }).trim());
  const dir = mkdtempSync(join(tmpdir(), 'partner-pg-'));
  const env = { PATH: process.env.PATH, HOME: dir, LANG: 'C.UTF-8' };
  let started = false, client;
  try {
    execFileSync(join(bin, 'initdb'), ['-D', join(dir, 'data'), '-A', 'trust', '--no-locale'], { env, stdio: 'ignore' });
    execFileSync(join(bin, 'pg_ctl'), ['-D', join(dir, 'data'), '-l', join(dir, 'pg.log'),
      '-o', `-k ${dir} -h ''`, '-w', 'start'], { env, stdio: 'ignore' });
    started = true;
    client = new pg.Client({ host: dir, database: 'postgres', user: process.env.USER || 'runner' });
    await client.connect();
    await client.query('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role');
    await client.query('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role');
    for (const table of ['member_membership_history', 'organisation_membership_history', 'membership_billing_agreements']) {
      await client.query(`CREATE TABLE ${table} (term_key text, membership_renewal_date date, term_duration_months integer,
        term_anchor_date date, commitment_snapshot jsonb, previous_term_id uuid, term_start_date date, term_end_date date,
        payment_status text, accounting_invoice_id text)`);
    }
    // Execute the production constraint DDL verbatim, not a JS approximation.
    const ddl = readFileSync(new URL('../../supabase/migrations/20261108_direct_debit_dated_commitments.sql', import.meta.url), 'utf8');
    await client.query(ddl.slice(0, ddl.indexOf('DO $migration$')));
    const migration = readFileSync(new URL('../../supabase/migrations/20261116_membership_incentive_snapshot.sql', import.meta.url), 'utf8');
    await client.query(migration);
    await client.query(migration); // idempotent
    for (const role of ['anon', 'authenticated', 'service_role']) {
      const result = await client.query("SELECT has_function_privilege($1,'public.protect_membership_incentive_snapshot()','EXECUTE') allowed", [role]);
      assert.equal(result.rows[0].allowed, false, `${role} cannot directly execute trigger function`);
    }
    await t.test('old partial snapshot fails; new automatic fixed-date row invoices net £1 / VAT £0.20', async () => {
      await assert.rejects(client.query('INSERT INTO organisation_membership_history(commitment_snapshot) VALUES ($1)',
        [JSON.stringify({ config: simulation().config })]), error => error.constraint === 'organisation_membership_history_rolling_complete_check');
      const h = harness(client, { yearMode: 'automatic', fallbackMode: 'manual' });
      const result = await h.run();
      assert.equal(result.status, 'success', JSON.stringify(result));
      assert.equal(h.inserts.length, 1); assert.equal(h.invoices.length, 1);
      const row = h.inserts[0];
      assert.equal(row.commitment_snapshot, undefined);
      assert.equal(row.term_key, undefined);
      assert.equal(row.incentive_snapshot.config.id, 'joining');
      assert.equal(row.final_cost, 1); assert.equal(row.vat_amount, .2); assert.equal(row.total_with_vat, 1.2);
      assert.equal(h.invoices[0].finalCost, 1); assert.equal(h.invoices[0].vatRate, 'OUTPUT2');
    });
    for (const [label, options, expected] of [
      ['year manual beats automatic fallback', { yearMode: 'manual', fallbackMode: 'automatic' }, 'skipped'],
      ['fallback manual', { fallbackMode: 'manual' }, 'skipped'],
      ['scheduled workflow defers to cron', { yearMode: 'scheduled' }, 'skipped'],
      ['unapproved', { yearMode: 'automatic', approved: false }, 'skipped'],
      ['duplicate', { yearMode: 'automatic', existing: true }, 'skipped'],
      ['automatic fallback', { fallbackMode: 'automatic' }, 'success'],
      ['default automatic', {}, 'success'],
    ]) await t.test(label, async () => {
      const h = harness(client, options); const result = await h.run();
      assert.equal(result.status, expected, JSON.stringify(result));
      assert.equal(h.invoices.length, expected === 'success' ? 1 : 0);
      assert.equal(h.inserts.length, expected === 'success' ? 1 : 0);
    });
    await t.test('immediate and fixed DD complete terms remain valid; incomplete terms still fail', async () => {
      const sim = simulation(); sim.config.start_mode = 'immediate';
      const complete = { ...membershipIncentiveSnapshot(sim), ...workflowRollingCommitment(sim) };
      for (const table of ['member_membership_history', 'organisation_membership_history']) {
        const insert = row => client.query(`INSERT INTO ${table} SELECT * FROM jsonb_populate_record(NULL::${table}, $1::jsonb)`, [JSON.stringify(row)]);
        await insert(complete);
        const fixedDd = structuredClone(complete);
        fixedDd.term_key = fixedDd.term_key.replace('rolling:', 'fixed:');
        fixedDd.commitment_snapshot.start_mode = 'fixed_date';
        fixedDd.commitment_snapshot.payment_method = 'direct_debit';
        await insert(fixedDd);
        await assert.rejects(insert({ ...complete, membership_renewal_date: null }), /rolling_complete_check/);
        await assert.rejects(insert({ ...complete, term_key: null }), /rolling_complete_check/);
      }
    });
    await t.test('legacy frozen incentive-only quote inserts without weakening commitment constraint', async () => {
      const sim = simulation();
      const legacy = { config: structuredClone(sim.config), amounts: { annual_cost: sim.annualCost } };
      sim.commitment_snapshot = legacy;
      sim.config = { ...sim.config, free_period_amount: 99 };
      const history = historyFromFormPaymentSnapshot({ simResult: sim });
      assert.deepEqual(history.incentive_snapshot, legacy);
      assert.equal(history.commitment_snapshot, undefined);
      for (const table of ['member_membership_history', 'organisation_membership_history']) {
        await client.query(`INSERT INTO ${table} SELECT * FROM jsonb_populate_record(NULL::${table}, $1::jsonb)`, [JSON.stringify(history)]);
      }
      assert.throws(() => incentiveFieldsFromSavedQuote({ ...sim, term_key: 'rolling:2026-08-01' }), /review required/);
    });
    await t.test('incentive evidence immutable for all updates including NULL legacy; unrelated financial updates succeed', async () => {
      await client.query('GRANT USAGE ON SCHEMA public TO authenticated');
      for (const table of ['member_membership_history', 'organisation_membership_history']) {
        await client.query(`INSERT INTO ${table} DEFAULT VALUES`);
        await client.query(`GRANT SELECT, UPDATE ON ${table} TO authenticated`);
      }
      await client.query('SET ROLE authenticated');
      for (const table of ['member_membership_history', 'organisation_membership_history']) {
        await client.query(`UPDATE ${table} SET payment_status='paid', accounting_invoice_id='mock', incentive_snapshot=incentive_snapshot`);
        await assert.rejects(client.query(`UPDATE ${table} SET incentive_snapshot=NULL WHERE incentive_snapshot IS NOT NULL`), /immutable/);
        await assert.rejects(client.query(`UPDATE ${table} SET incentive_snapshot='{}' WHERE incentive_snapshot IS NOT NULL`), /immutable/);
        await assert.rejects(client.query(`UPDATE ${table} SET incentive_snapshot='{}' WHERE incentive_snapshot IS NULL`), /immutable/);
      }
      await client.query('RESET ROLE');
    });
  } finally {
    await client?.end();
    if (started) execFileSync(join(bin, 'pg_ctl'), ['-D', join(dir, 'data'), '-m', 'immediate', '-w', 'stop'], { env, stdio: 'ignore' });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dedicated incentive evidence wins over mutable renewal/commitment config; legacy reads remain valid', () => {
  const sim = { ...simulation(), annualCost: 1000 };
  const saved = membershipIncentiveSnapshot(sim);
  sim.config.free_period_amount = 90;
  const history = { ...saved, annual_cost: 1000, free_period_discount: 100,
    commitment_snapshot: { config: sim.config } };
  const result = calculateOriginalIncentiveRollover({ history, annualCost: 2000 });
  assert.equal(result.source, 'incentive_snapshot');
  assert.equal(result.originalEntitlement, 400);
  assert.equal(result.appliedDiscount, 300);
  const legacy = { ...history, incentive_snapshot: undefined,
    commitment_snapshot: saved.incentive_snapshot };
  assert.equal(calculateOriginalIncentiveRollover({ history: legacy, annualCost: 2000 }).appliedDiscount, 300);
  assert.throws(() => calculateOriginalIncentiveRollover({ history: { ...history, incentive_snapshot: {} }, annualCost: 2000 }), /requires review/);
});

test('Specify date keeps existing before/on-date schedule and manual stays excluded from automatic cron selection', async () => {
  for (const existing of [false, true]) {
    for (const [date, due] of [['2026-09-30', false], ['2026-10-01', true]]) {
      const sim = { ...simulation(), goLiveDate: '2026-09-01' };
      sim.config.nominal_code = '4020';
      if (existing) sim.existingRecord = { id: 'existing' };
      const record = { id: 'existing', membership_year: '2026/2027',
        final_cost: 1, total_with_vat: 1.2, currency: 'GBP' };
      const db = { from(table) {
        let fields;
        const q = { select(s) { fields = s; return q; }, eq() { return q; },
          maybeSingle() { return q; }, single() { return q; },
          then(resolve, reject) {
            let data;
            if (table === 'system_settings') data = { setting_value: 'true' };
            else if (table === 'organisation_membership_invoicing') {
              data = fields?.includes('fees_approved')
                ? [{ fees_approved: true, membership_year: '2026/2027' }] : {};
            } else if (table === 'organisation_membership_history') data = record;
            else if (table === 'organization') data = {};
            else throw new Error(`Unexpected scheduled read ${table}`);
            return Promise.resolve({ data, error: null }).then(resolve, reject);
          },
        }; return q;
      } };
      const operations = [];
      const result = await runAnnualOwnerRow({ db, tenantId: 'tenant', scope: 'organisation',
        now: new Date(`${date}T12:00:00Z`),
        setting: { organization_id: 'org', membership_year: '2026/2027', invoicing_mode: 'scheduled', invoice_date: '2026-10-01' },
        simulator: { simulateMembershipForOrg: async () => sim },
        effects: { perform: async operation => { operations.push(operation); return operation; } },
      });
      if (existing && !due) {
        assert.equal(result.skipped, true); assert.equal(operations.length, 0);
      } else {
        assert.equal(operations.length, 1);
        assert.equal(operations[0].payload.invoiceDue, due);
        assert.equal(operations[0].type, existing ? 'owner.annual_invoice' : 'owner.annual_history_insert');
        if (!existing) {
          assert.ok(operations[0].payload.values.incentive_snapshot);
          assert.equal(operations[0].payload.values.commitment_snapshot, undefined);
        }
      }
    }
  }
  const db = { from() { return { select() { return this; }, eq() { return this; },
    in(column, modes) { assert.equal(column, 'invoicing_mode'); assert.deepEqual(modes, ['automatic', 'scheduled']); return []; } }; } };
  assert.deepEqual(await selectAnnualOwnerSettings(db, 'tenant', 'organisation'), []);
});