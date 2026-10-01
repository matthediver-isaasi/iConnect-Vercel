import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';
import { annualOwnerRenewalRows, runAnnualOwnerRow } from './annualOwnerRenewalPipeline.js';
import { renewalRows } from './membershipRenewalBudget.js';

const tenantId = '22222222-2222-4222-8222-222222222222';
const productionCursor = 'b3910308-e210-491e-9db3-01035cdfd2c7';
const beforeOwner = 'a3910308-e210-491e-9db3-01035cdfd2c7';
const afterOwner = 'c3910308-e210-491e-9db3-01035cdfd2c7';
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ownerColumn = scope => scope === 'member' ? 'member_id' : 'organization_id';
const settingsTable = scope => `${scope === 'member' ? 'member' : 'organisation'}_membership_invoicing`;
const historyTable = scope => `${scope === 'member' ? 'member' : 'organisation'}_membership_history`;
const setting = (scope, n, owner = productionCursor, year = String(2020 + n)) => ({
  id: id(n), tenant_id: tenantId, [ownerColumn(scope)]: owner,
  membership_year: year, invoicing_mode: 'scheduled', invoice_date: '2020-01-01',
});
const cursorFor = (scope, row) => ({
  version: 1, key: ownerColumn(scope), value: row[ownerColumn(scope)], tieBreaker: 'id', tieValue: row.id,
});

// Read-only, ordered PostgREST fixture with a server cap smaller than the
// requested limit. No database/provider singleton or network is used.
function fixture(tables, cap = 3) {
  const queries = [];
  return { queries, from(table) {
    const filters = [], orders = [];
    let limit = Infinity, single = false;
    const call = { table, filters: [] };
    const q = {
      select() { return q; },
      eq(key, value) { filters.push(row => row[key] === value); return q; },
      in(key, values) { filters.push(row => values.includes(row[key])); return q; },
      gt(key, value) { call.filters.push(['gt', key, value]); filters.push(row => row[key] > value); return q; },
      gte(key, value) { call.filters.push(['gte', key, value]); filters.push(row => row[key] >= value); return q; },
      or(expression) {
        call.filters.push(['or', expression]);
        const match = expression.match(/^(\w+)\.gt\.("[^"]+"),and\((\w+)\.eq\.("[^"]+"),(\w+)\.gt\.("[^"]+")\)$/);
        assert.ok(match, `Unexpected keyset expression: ${expression}`);
        const [, key, value, sameKey, sameValue, tieKey, tieValue] = match;
        assert.equal(key, sameKey);
        assert.equal(value, sameValue);
        filters.push(row => row[key] > JSON.parse(value)
          || (row[key] === JSON.parse(value) && row[tieKey] > JSON.parse(tieValue)));
        return q;
      },
      order(key, { ascending = true } = {}) { assert.equal(ascending, true); orders.push(key); return q; },
      limit(value) { limit = value; return q; },
      maybeSingle() { single = true; return q; },
      single() { single = true; return q; },
      then(resolve, reject) {
        try {
          queries.push(call);
          const rows = (tables[table] || []).filter(row => filters.every(f => f(row))).sort((a, b) => {
            for (const key of orders) {
              if (a[key] < b[key]) return -1;
              if (a[key] > b[key]) return 1;
            }
            return 0;
          }).slice(0, Math.min(limit, cap));
          resolve({ data: single ? rows[0] || null : rows, error: null });
        } catch (error) { reject(error); }
      },
      insert() { assert.fail('No database writes permitted'); },
      update() { assert.fail('No database writes permitted'); },
      delete() { assert.fail('No database writes permitted'); },
    };
    return q;
  } };
}
function controlFor(cursor = null, budget = Infinity) {
  return {
    cursor, checkpoints: [],
    shouldContinue() { return this.checkpoints.length < budget; },
    async checkpoint(next) { this.cursor = structuredClone(next); this.checkpoints.push(this.cursor); },
  };
}
async function consume(db, scope, control, seen, options = {}) {
  for await (const row of annualOwnerRenewalRows(db, tenantId, scope, { control, ...options })) seen.push(row.id);
}

for (const scope of ['member', 'organisation']) {
  test(`${scope}: all years (including null fallback) survive capped pages and mid-owner resumption`, async () => {
    const rows = Array.from({ length: 111 }, (_, n) => setting(scope, n + 1, productionCursor, n ? String(2000 + n) : null));
    rows.unshift(setting(scope, 501, beforeOwner));
    rows.push(setting(scope, 502, afterOwner));
    const db = fixture({ [settingsTable(scope)]: [...rows].reverse().concat([
      { ...setting(scope, 503), tenant_id: 'another-tenant' },
      { ...setting(scope, 504), invoicing_mode: 'manual' },
    ]) }, 7);
    const first = controlFor(null, 19), seen = [];
    await assert.rejects(consume(db, scope, first, seen), { code: 'RENEWAL_BUDGET_EXHAUSTED' });
    assert.deepEqual(first.cursor, cursorFor(scope, rows[18]));
    const resumed = controlFor(JSON.parse(JSON.stringify(first.cursor)));
    await consume(db, scope, resumed, seen);
    assert.deepEqual(seen, rows.map(row => row.id));
    assert.equal(new Set(seen).size, seen.length);
    assert.deepEqual(resumed.cursor, cursorFor(scope, rows.at(-1)));
  });

  test(`${scope}: real legacy owner UUID replays only boundary owner and migrates to exact row cursor`, async () => {
    const rows = [setting(scope, 1, beforeOwner), setting(scope, 2), setting(scope, 3), setting(scope, 4), setting(scope, 5, afterOwner)];
    const db = fixture({ [settingsTable(scope)]: rows }, 1);
    const first = controlFor(productionCursor, 2), seen = [];
    await assert.rejects(consume(db, scope, first, seen), { code: 'RENEWAL_BUDGET_EXHAUSTED' });
    assert.deepEqual(seen, [id(2), id(3)]);
    assert.deepEqual(db.queries[0].filters, [['gte', ownerColumn(scope), productionCursor]]);
    assert.deepEqual(first.cursor, { ...cursorFor(scope, rows[2]), legacyBoundary: productionCursor });
    await consume(db, scope, controlFor(first.cursor), seen);
    assert.deepEqual(seen, rows.slice(1).map(row => row.id));
  });

  test(`${scope}: legacy replay suppresses already-invoiced years and processes unfinished siblings`, async () => {
    const rows = [setting(scope, 1), setting(scope, 2), setting(scope, 3), setting(scope, 4)];
    rows[0].invoicing_mode = 'automatic';
    const existing = new Map([
      [rows[0].membership_year, { id: id(901), accounting_invoice_id: 'qbo-automatic-existing' }],
      [rows[1].membership_year, { id: id(902), xero_invoice_id: 'xero-existing' }],
      [rows[2].membership_year, { id: id(903), accounting_invoice_id: 'qbo-existing' }],
    ]);
    const db = fixture({
      [settingsTable(scope)]: rows,
      [historyTable(scope)]: [...existing.values()].map(record => ({ ...record, tenant_id: tenantId })),
    }, 2);
    const effects = [];
    const simulator = {
      async simulateMembershipForMember(_tenant, _owner, { targetYear }) {
        return {
          success: true, member: { id: productionCursor }, org: { id: productionCursor },
          goLiveDate: '2020-01-01', config: { id: id(999) },
          membershipYear: { label: targetYear, start: '2020-01-01' },
          existingRecord: existing.get(targetYear), finalCost: 100, totalWithVat: 100,
        };
      },
    };
    simulator.simulateMembershipForOrg = simulator.simulateMembershipForMember;
    const control = controlFor(productionCursor);
    for await (const row of annualOwnerRenewalRows(db, tenantId, scope, { control })) {
      await runAnnualOwnerRow({ db, tenantId, scope, setting: row, simulator, now: new Date('2026-01-01'),
        effects: { async perform(op) { effects.push(op); } } });
    }
    assert.equal(effects.length, 1);
    assert.equal(effects[0].type, 'owner.annual_history_insert');
    assert.equal(effects[0].payload.values.membership_year, rows[3].membership_year);
    assert.equal(control.checkpoints.length, rows.length);
  });

  test(`${scope}: freshly loaded invoice linkage wins over stale simulation before a replay write`, async () => {
    for (const invoiceColumn of ['xero_invoice_id', 'accounting_invoice_id']) {
      const row = setting(scope, 1);
      const record = { id: id(901), tenant_id: tenantId, [invoiceColumn]: 'existing' };
      const db = fixture({ [historyTable(scope)]: [record] });
      const simulate = async () => ({
        success: true, member: {}, org: {}, goLiveDate: '2020-01-01',
        membershipYear: { start: '2020-01-01', label: row.membership_year },
        existingRecord: { id: record.id },
      });
      const result = await runAnnualOwnerRow({ db, tenantId, scope, setting: row, now: new Date('2026-01-01'),
        simulator: { simulateMembershipForMember: simulate, simulateMembershipForOrg: simulate },
        effects: { perform() { assert.fail('Existing invoice must never be recreated'); } } });
      assert.match(result.reason, /already exists with invoice/);
    }
  });

  test(`${scope}: ambiguous legacy-boundary provider success is withheld across cursor migration and resume`, async () => {
    for (const mode of ['automatic', 'scheduled']) {
      const rows = [setting(scope, 1), { ...setting(scope, 2), invoicing_mode: mode }, setting(scope, 3, afterOwner)];
      const linked = { id: id(901), tenant_id: tenantId, accounting_invoice_id: 'verified-provider-invoice' };
      // Represents provider creation success followed by missing/failed linkage.
      // The handler cannot safely distinguish it from an unattempted invoice.
      const ambiguous = { id: id(902), tenant_id: tenantId, final_cost: 100, total_with_vat: 100 };
      const db = fixture({ [settingsTable(scope)]: rows, [historyTable(scope)]: [linked, ambiguous] }, 1);
      const simulate = async (_tenant, _owner, { targetYear }) => ({
        success: true, member: {}, org: {}, goLiveDate: '2020-01-01',
        membershipYear: { start: '2020-01-01', label: targetYear },
        existingRecord: targetYear === rows[0].membership_year ? linked : ambiguous,
      });
      let effects = 0;
      const runRow = row => runAnnualOwnerRow({ db, tenantId, scope, setting: row, now: new Date('2026-01-01'),
        simulator: { simulateMembershipForMember: simulate, simulateMembershipForOrg: simulate },
        effects: { perform() { effects++; assert.fail('Ambiguous provider write must never be repeated'); } } });
      const first = controlFor(productionCursor, 1);
      await assert.rejects(async () => {
        for await (const row of annualOwnerRenewalRows(db, tenantId, scope, { control: first })) {
          const result = await runRow(row);
          assert.match(result.reason, /already exists with invoice/);
        }
      }, { code: 'RENEWAL_BUDGET_EXHAUSTED' });
      assert.deepEqual(first.cursor, { ...cursorFor(scope, rows[0]), legacyBoundary: productionCursor });
      const resumed = controlFor(JSON.parse(JSON.stringify(first.cursor)));
      await assert.rejects(async () => {
        for await (const row of annualOwnerRenewalRows(db, tenantId, scope, { control: resumed })) await runRow(row);
      }, error => error.code === 'RENEWAL_LEGACY_BOUNDARY_REVIEW_REQUIRED'
        && /prior provider success is unknown/.test(error.message));
      assert.equal(effects, 0);
      assert.deepEqual(resumed.checkpoints, []);
      assert.deepEqual(resumed.cursor, first.cursor);
      // Repair/reconciliation is external to cron. Once authoritative linkage
      // exists, the same saved cursor can safely advance without an invoice.
      ambiguous.xero_invoice_id = 'reconciled-existing-invoice';
      const afterReview = controlFor(resumed.cursor);
      for await (const row of annualOwnerRenewalRows(db, tenantId, scope, { control: afterReview })) await runRow(row);
      assert.deepEqual(afterReview.cursor, cursorFor(scope, rows[2]));
      assert.equal(effects, 0);
    }
  });

  test(`${scope}: ordinary non-legacy automatic history behavior is unchanged`, async () => {
    const simulate = async () => ({
      success: true, member: {}, org: {}, goLiveDate: '2020-01-01',
      membershipYear: { start: '2020-01-01', label: '2026' }, existingRecord: { id: id(901) },
    });
    const result = await runAnnualOwnerRow({ db: fixture({}), tenantId, scope,
      setting: { ...setting(scope, 1), invoicing_mode: 'automatic' }, now: new Date('2026-01-01'),
      simulator: { simulateMembershipForMember: simulate, simulateMembershipForOrg: simulate },
      effects: { perform() { assert.fail('Normal automatic existing history is skipped'); } } });
    assert.match(result.reason, /already exists/);
  });

  for (const mode of ['automatic', 'scheduled']) {
    test(`${scope}/${mode}: fresh paid explicit zero safely resumes boundary and continues pagination without an invoice`, async () => {
      for (const amount of [0, '0.00']) {
        const rows = [setting(scope, 1), { ...setting(scope, 2), invoicing_mode: mode }, setting(scope, 3, afterOwner)];
        const linked = { id: id(901), tenant_id: tenantId, accounting_invoice_id: 'existing-invoice' };
        const zero = { id: id(902), tenant_id: tenantId, payment_status: 'paid', paid_at: '2026-01-01',
          total_with_vat: amount, final_cost: amount };
        const db = fixture({ [settingsTable(scope)]: rows, [historyTable(scope)]: [linked, zero] }, 1);
        const simulate = async (_tenant, _owner, { targetYear }) => ({
          success: true, member: {}, org: {}, goLiveDate: '2020-01-01',
          membershipYear: { start: '2020-01-01', label: targetYear },
          // Only the fresh history read proves no invoice is due.
          existingRecord: targetYear === rows[1].membership_year
            ? { id: zero.id, payment_status: 'unpaid', total_with_vat: 100 } : linked,
        });
        const operations = [], visited = [];
        const run = async control => {
          for await (const row of annualOwnerRenewalRows(db, tenantId, scope, { control })) {
            visited.push(row.id);
            await runAnnualOwnerRow({ db, tenantId, scope, setting: row, now: new Date('2026-01-01'),
              simulator: { simulateMembershipForMember: simulate, simulateMembershipForOrg: simulate },
              effects: { async perform(op) {
                assert.equal(op.type, 'owner.annual_zero_workflow', 'No invoice/provider effect is permitted');
                assert.equal(op.payload.row, zero);
                operations.push(op);
              } } });
          }
        };
        const first = controlFor(productionCursor, 1);
        await assert.rejects(run(first), { code: 'RENEWAL_BUDGET_EXHAUSTED' });
        assert.equal(first.cursor.legacyBoundary, productionCursor);
        const resumed = controlFor(JSON.parse(JSON.stringify(first.cursor)), 1);
        await assert.rejects(run(resumed), { code: 'RENEWAL_BUDGET_EXHAUSTED' });
        assert.deepEqual(resumed.cursor, { ...cursorFor(scope, rows[1]), legacyBoundary: productionCursor });
        const tail = controlFor(JSON.parse(JSON.stringify(resumed.cursor)));
        await run(tail);
        assert.deepEqual(visited, rows.map(row => row.id));
        assert.deepEqual(tail.cursor, cursorFor(scope, rows[2]));
        assert.equal(operations.length, mode === 'scheduled' ? 1 : 0);
      }
    });

    test(`${scope}/${mode}: unknown or nonzero fresh amounts never qualify for the no-invoice boundary exemption`, async () => {
      const row = { ...setting(scope, 2), invoicing_mode: mode };
      const cases = [undefined, null, '', ' ', NaN, Infinity, -Infinity, 'NaN', 'Infinity',
        false, [], 'not-a-number', 0.001, '0.001', 1].map(amount => ({
        payment_status: 'paid', total_with_vat: amount, final_cost: amount,
      }));
      cases.push({ payment_status: 'unpaid', total_with_vat: 0, final_cost: 0 },
        { total_with_vat: 0, final_cost: 0 });
      for (const values of cases) {
        const record = { id: id(902), tenant_id: tenantId, ...values };
        const db = fixture({ [settingsTable(scope)]: [row], [historyTable(scope)]: [record] });
        const simulate = async () => ({
          success: true, member: {}, org: {}, goLiveDate: '2020-01-01',
          membershipYear: { start: '2020-01-01', label: row.membership_year },
          existingRecord: { id: record.id, payment_status: 'paid', total_with_vat: 0 },
        });
        const control = controlFor({ ...cursorFor(scope, setting(scope, 1)), legacyBoundary: productionCursor });
        await assert.rejects(async () => {
          for await (const current of annualOwnerRenewalRows(db, tenantId, scope, { control })) {
            await runAnnualOwnerRow({ db, tenantId, scope, setting: current, now: new Date('2026-01-01'),
              simulator: { simulateMembershipForMember: simulate, simulateMembershipForOrg: simulate },
              effects: { perform() { assert.fail('Unknown/nonzero amount cannot authorize any effect'); } } });
          }
        }, { code: 'RENEWAL_LEGACY_BOUNDARY_REVIEW_REQUIRED' });
        assert.deepEqual(control.checkpoints, []);
      }
    });
  }
}

test('unknown or malformed composite cursors fail closed before queries or effects', async () => {
  const valid = cursorFor('member', setting('member', 1));
  for (const cursor of [{}, true, [], { ...valid, version: 2 }, { ...valid, key: 'organization_id' },
    { ...valid, tieBreaker: 'membership_year' }, { ...valid, tieValue: null }, { ...valid, value: '' },
    { ...valid, legacyBoundary: beforeOwner }, { ...valid, legacyBoundary: null }]) {
    const db = fixture({});
    await assert.rejects(consume(db, 'member', controlFor(cursor), []), /Invalid renewal pagination cursor/);
    assert.deepEqual(db.queries, []);
  }
});

test('failed annual row retains the last successful exact cursor for retry, including same-owner siblings', async () => {
  const rows = [setting('member', 1), setting('member', 2), setting('member', 3)];
  const db = fixture({ member_membership_invoicing: rows });
  const control = controlFor(), results = { errors: 0 }, seen = [];
  await assert.rejects(async () => {
    for await (const row of annualOwnerRenewalRows(db, tenantId, 'member', { control, results })) {
      seen.push(row.id);
      if (row.id === id(2)) results.errors++;
    }
  }, { code: 'RENEWAL_ROW_FAILED' });
  assert.deepEqual(control.cursor, cursorFor('member', rows[0]));
  const retried = [];
  await consume(db, 'member', controlFor(control.cursor), retried);
  assert.deepEqual(retried, [id(2), id(3)]);
});

test('invalid/missing/nonadvancing page rows are rejected before financial effects', async () => {
  const row = setting('member', 2), cursor = cursorFor('member', row);
  for (const invalid of [{ ...row }, { ...row, id: id(1) }, { ...row, id: null },
    { ...row, member_id: beforeOwner }, { ...row, member_id: null }]) {
    // Deliberately ignore filtering to simulate an invalid/repeated DB page.
    const factory = () => ({
      order() { return this; }, limit() { return this; }, or() { return this; },
      then(resolve) { resolve({ data: [invalid] }); },
    });
    const control = controlFor(cursor);
    await assert.rejects(async () => {
      for await (const _row of renewalRows(factory, { key: 'member_id', tieBreaker: 'id', control })) {
        assert.fail('Invalid row was yielded to financial handler');
      }
    }, /Invalid renewal pagination cursor/);
    assert.deepEqual(control.checkpoints, []);
  }
});

test('plain UUID remains a strictly exclusive ID cursor for ordinary renewal streams', async () => {
  const db = fixture({ rows: [{ id: beforeOwner }, { id: productionCursor }, { id: afterOwner }] });
  const control = controlFor(productionCursor), seen = [];
  for await (const row of renewalRows(() => db.from('rows').select('*'), { control })) seen.push(row.id);
  assert.deepEqual(seen, [afterOwner]);
  assert.equal(control.cursor, afterOwner);
});

test('actual Supabase builder sends stable owner/id ordering and scoped lexicographic continuation', async () => {
  const row = setting('member', 2), requests = [];
  const db = createClient('https://pagination.example.invalid', 'isolated-test-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (url, options) => {
      assert.equal(options.method, 'GET');
      requests.push(new URL(url));
      return new Response(JSON.stringify(requests.length === 1 ? [row] : []), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    } },
  });
  const control = controlFor(productionCursor), seen = [];
  await consume(db, 'member', control, seen);
  assert.deepEqual(seen, [row.id]);
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.pathname, '/rest/v1/member_membership_invoicing');
    assert.equal(request.searchParams.get('tenant_id'), `eq.${tenantId}`);
    assert.equal(request.searchParams.get('invoicing_mode'), 'in.(automatic,scheduled)');
    assert.equal(request.searchParams.get('order'), 'member_id.asc,id.asc');
    assert.equal(request.searchParams.get('limit'), '100');
  }
  assert.equal(requests[0].searchParams.get('member_id'), `gte.${productionCursor}`);
  assert.equal(requests[1].searchParams.get('member_id'), null);
  assert.equal(requests[1].searchParams.get('or'),
    `(member_id.gt."${productionCursor}",and(member_id.eq."${productionCursor}",id.gt."${row.id}"))`);
});

test('resumption does not require the checkpoint row still to exist or remain eligible', async () => {
  const deleted = setting('member', 2);
  const remaining = [setting('member', 1), setting('member', 3), setting('member', 4, afterOwner)];
  const db = fixture({ member_membership_invoicing: remaining });
  const seen = [];
  await consume(db, 'member', controlFor(cursorFor('member', deleted)), seen);
  assert.deepEqual(seen, [id(3), id(4)]);
});

test('budget expiry during an effect still checkpoints that completed row before deferring', async () => {
  const row = setting('member', 1), db = fixture({ member_membership_invoicing: [row, setting('member', 2)] });
  let available = true;
  const control = { ...controlFor(), shouldContinue: () => available };
  await assert.rejects(async () => {
    for await (const current of annualOwnerRenewalRows(db, tenantId, 'member', { control })) {
      assert.equal(current.id, row.id);
      available = false;
    }
  }, { code: 'RENEWAL_BUDGET_EXHAUSTED' });
  assert.deepEqual(control.checkpoints, [cursorFor('member', row)]);
});

test('production cron uses the shared annual-owner composite cursor entry', async () => {
  const cron = await readFile(new URL('../cron/process-membership-renewals.js', import.meta.url), 'utf8');
  assert.match(cron, /annualOwnerRenewalRows\(supabase, tenantId, scope,/);
  assert.doesNotMatch(cron, /key: column, control: results\.__renewalControl/);
});