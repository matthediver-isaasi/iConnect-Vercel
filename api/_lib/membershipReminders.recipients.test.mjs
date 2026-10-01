import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMembershipReminders } from './membershipReminders.js';

const schemas = Object.fromEntries(['Member', 'Organization'].map(name => [
  name.toLowerCase(),
  new Set(['id', 'tenant_id', ...Object.keys(JSON.parse(
    readFileSync(new URL(`../../schema/${name}.json`, import.meta.url), 'utf8'),
  ).properties)]),
]));

// Exercise the real query builders, including column validation and projection.
// Reads stay in memory; all delivery/claim effects are controlled separately.
function fixtureDatabase(tables, queries) {
  return { from(table) {
    assert.ok(Object.hasOwn(tables, table), `Unexpected table ${table}`);
    const filters = [];
    const predicates = [];
    let columns = '*', single = false, maximum = Infinity;
    const query = {
      select(value) { columns = value; return query; },
      eq(key, value) {
        filters.push(['eq', key, value]);
        predicates.push(row => row[key] === value);
        return query;
      },
      neq(key, value) { predicates.push(row => row[key] !== value); return query; },
      gte(key, value) { predicates.push(row => row[key] >= value); return query; },
      is(key, value) {
        filters.push(['is', key, value]);
        predicates.push(row => (row[key] ?? null) === value);
        return query;
      },
      in(key, values) {
        filters.push(['in', key, values]);
        predicates.push(row => values.includes(row[key]));
        return query;
      },
      not(key, operator, value) {
        if (operator === 'is') predicates.push(row => row[key] != null);
        else if (operator === 'in') predicates.push(row => !value.slice(1, -1).split(',').includes(row[key]));
        else assert.fail(`Unexpected not operator ${operator}`);
        return query;
      },
      or(expression) {
        assert.equal(expression, 'payment_status.eq.paid,paid_at.not.is.null');
        predicates.push(row => row.payment_status === 'paid' || row.paid_at != null);
        return query;
      },
      limit(value) { maximum = value; return query; },
      maybeSingle() { single = true; return query; },
      insert() { assert.fail('Direct database writes forbidden in reminder fixture'); },
      update() { assert.fail('Direct database writes forbidden in reminder fixture'); },
      then(resolve, reject) {
        return Promise.resolve().then(() => {
          queries.push({ table, columns, filters });
          const selectedColumns = columns.split(',').map(column => column.trim());
          const invalid = columns !== '*' && schemas[table]
            && selectedColumns.find(column => !schemas[table].has(column));
          if (invalid) return { data: null, error: { code: '42703', message: `column ${table}.${invalid} does not exist` } };
          const rows = tables[table].filter(row => predicates.every(predicate => predicate(row)))
            .slice(0, maximum).map(row => columns === '*' ? { ...row }
              : Object.fromEntries(selectedColumns.map(column => [column, row[column]])));
          return { data: single ? rows[0] || null : rows, error: null };
        }).then(resolve, reject);
      },
    };
    return query;
  } };
}

function setup(scope = 'member', mode = 'rolling', names = {}) {
  const memberScope = scope === 'member';
  const config = { id: 'config', tenant_id: 'tenant', structure_scope_type: scope, effective_to: null,
    start_mode: mode === 'rolling' ? 'immediate' : 'fixed', billing_period: 'annual',
    renewal_open_days: 30, renewal_grace_days: 7, online_card_payment: true };
  const member = { id: memberScope ? 'owner' : 'recipient', tenant_id: 'tenant',
    first_name: ' Ada ', last_name: ' Lovelace ', email: 'member@example.test', role_id: 'role',
    organization_id: memberScope ? null : 'owner', ...names };
  const organization = { id: 'owner', tenant_id: 'tenant', name: 'Fixture Organization' };
  const history = { id: 'history', tenant_id: 'tenant', config_id: 'config', status: 'active',
    [memberScope ? 'member_id' : 'organization_id']: 'owner',
    membership_year: '2025/2026', billing_period: 'annual', final_cost: 100, currency: 'GBP',
    term_start_date: '2025-01-01', term_end_date: '2025-12-31', membership_renewal_date: '2026-01-01',
    ...(mode === 'rolling' ? { term_key: 'rolling:2025-01-01',
      commitment_snapshot: { config, start_mode: 'immediate', payment_frequency: 'upfront' } } : {}) };
  const reminder = { id: 'reminder', tenant_id: 'tenant', config_id: 'config', is_active: true,
    email_template_id: 'template', recipient_role_ids: ['role'],
    offset_value: 30, offset_unit: 'days', direction: 'before' };
  const template = { id: 'template', tenant_id: 'tenant', is_active: true,
    subject: '{{member_name}}|{{memberName}}|{{organization_name}}|{{organizationName}}',
    body: `{{member_name}}|{{memberName}}|{{organization_name}}|{{organizationName}}${mode === 'payment' ? '|{{payment_link}}' : ''}` };
  const tables = {
    member: [{ ...member, tenant_id: 'other', first_name: 'Wrong tenant' }, member],
    organization: [{ ...organization, tenant_id: 'other', name: 'Wrong tenant organization' }, organization],
    member_membership_history: memberScope && mode !== 'fixed' ? [history] : [],
    organisation_membership_history: !memberScope && mode !== 'fixed' ? [history] : [],
    membership_tier_config: [{ ...config, tenant_id: 'other' }, config],
    membership_tier_reminder: [{ ...reminder, tenant_id: 'other' }, reminder],
    email_template: [{ ...template, tenant_id: 'other', subject: 'Wrong tenant template' }, template],
    membership_billing_agreements: [],
    // Another tenant's delivery must not suppress this tenant's reminder.
    membership_tier_reminder_send: [{ id: 'foreign-send', tenant_id: 'other',
      reminder_id: 'reminder', membership_year: mode === 'rolling' ? history.term_key : '2026/2027',
      scope_type: scope, [memberScope ? 'member_id' : 'organization_id']: 'owner', status: 'sent' }],
  };
  if (!memberScope) tables.member.push(
    { ...member, id: 'wrong-role', role_id: 'other-role', email: 'wrong-role@example.test' },
    { ...member, id: 'wrong-org', organization_id: 'another-org', email: 'wrong-org@example.test' },
    { ...member, id: 'no-email', email: null },
  );
  const queries = [], effects = [], renders = [];
  const db = fixtureDatabase(tables, queries);
  const simulate = async (tenantId, ownerId) => {
    assert.equal(tenantId, 'tenant');
    assert.equal(ownerId, 'owner');
    return { success: true, config, finalCost: 100, annualCost: 100, currency: 'GBP', tierLabel: 'Fixture tier',
      membershipYear: { label: '2026/2027', start: '2026-01-01', end: '2026-12-31' } };
  };
  const paused = new Set();
  const helpers = createMembershipReminders({
    db, now: new Date('2025-12-15T12:00:00Z'),
    simulateMembershipForMember: simulate, simulateMembershipForOrg: simulate,
    getPausedMemberIdSet: async tenantId => { assert.equal(tenantId, 'tenant'); return paused; },
    replacePlaceholders: (text, entity, data) => {
      renders.push({ entity, data });
      return text.replace(/\{\{(\w+)\}\}/g, (_, key) => data[key] ?? '');
    },
    loadAddonLines: async () => [], computeAddonTotals: () => ({ subtotal: 0, vat: 0, total: 0 }),
    buildAddonDisplayLines: () => [],
    getStripeCredentials: async () => ({ is_enabled: true, secret_key: 'fixture', publishable_key: 'fixture' }),
    effects: { async perform(operation) {
      effects.push(operation);
      switch (operation.type) {
        case 'reminder.claim': return { data: { id: 'claim', sent_at: operation.payload.sentAt }, error: null };
        case 'reminder.finish':
        case 'reminder.log': return { error: null };
        case 'reminder.category': return 'category';
        case 'reminder.email': return { success: true };
        case 'reminder.inbox_record':
        case 'reminder.inbox_delivery': return {};
        case 'reminder.prepare_token': return { success: true, paymentUrl: 'https://fixture.test/payment',
          finalCost: operation.payload.finalCost, currency: operation.payload.currency,
          tierLabel: operation.payload.tierLabel, costBreakdown: operation.payload.costBreakdown };
        default: assert.fail(`Unexpected effect ${operation.type}`);
      }
    } },
  });
  return { tables, queries, effects, renders, paused, db, async run() {
    const results = { details: [] };
    await helpers.processTenantReminders('tenant', results);
    return results;
  } };
}

function assertTenantQueries(queries) {
  for (const query of queries) {
    assert.ok(query.filters.some(([operator, key, value]) =>
      operator === 'eq' && key === 'tenant_id' && value === 'tenant'),
    `${query.table} query must be tenant-scoped`);
  }
}

test('query fixture rejects member.name rather than ignoring the actual selection', async () => {
  const f = setup();
  const result = await f.db.from('member').select('id, name').eq('tenant_id', 'tenant');
  assert.equal(result.error.code, '42703');
  assert.equal(result.error.message, 'column member.name does not exist');
});

for (const mode of ['rolling', 'fixed', 'payment']) {
  for (const scope of ['member', 'organization']) {
    test(`${mode} ${scope} reminders select real member columns and keep organization names separate`, async () => {
      const f = setup(scope, mode);
      const results = await f.run();
      assert.equal(results.processed, 1);
      assert.equal(results.errors || 0, 0);
      const sends = f.effects.filter(effect => effect.type === 'reminder.email');
      assert.equal(sends.length, 1);
      assert.equal(sends[0].payload.tenantId, 'tenant');
      assert.deepEqual([sends[0].payload.to].flat(), ['member@example.test']);
      const organizationName = scope === 'organization' ? 'Fixture Organization' : '';
      assert.equal(sends[0].payload.subject, `Ada Lovelace|Ada Lovelace|${organizationName}|${organizationName}`);
      assertTenantQueries(f.queries);
      for (const query of f.queries.filter(query => query.table === 'member')) {
        if (query.columns === '*') continue; // Payment-link owner lookup reads the existing row.
        assert.deepEqual(query.columns.split(',').map(column => column.trim()),
          ['id', 'email', 'first_name', 'last_name', 'role_id']);
      }
      if (scope === 'organization') {
        const recipientQuery = f.queries.find(query => query.table === 'member'
          && query.filters.some(([, key]) => key === 'organization_id'));
        assert.ok(recipientQuery);
        assert.ok(recipientQuery.filters.some(([op, key, value]) =>
          op === 'eq' && key === 'organization_id' && value === 'owner'));
        assert.ok(recipientQuery.filters.some(([op, key, value]) =>
          op === 'in' && key === 'role_id' && value.includes('role')));
        assert.ok(f.queries.some(query => query.table === 'organization'
          && (mode === 'payment' || query.columns === 'id, name')));
      }
      if (mode === 'rolling') {
        const claim = f.effects.find(effect => effect.type === 'reminder.claim');
        assert.equal(claim.payload.identity.scope_type, scope);
        assert.equal(claim.payload.identity.tenant_id, 'tenant');
        assert.equal(claim.payload.identity[scope === 'member' ? 'member_id' : 'organization_id'], 'owner');
        assert.equal(f.effects.find(effect => effect.type === 'reminder.finish').payload.values.status, 'sent');
      }
      assert.equal(f.renders[0].entity, scope);
    });
  }
}

for (const [names, expected] of [
  [{ first_name: ' Ada ', last_name: null }, 'Ada'],
  [{ first_name: null, last_name: ' Lovelace ' }, 'Lovelace'],
  [{ first_name: ' ', last_name: null }, 'member@example.test'],
]) {
  for (const mode of ['rolling', 'fixed', 'payment']) {
    for (const scope of ['member', 'organization']) {
      test(`${mode} ${scope} name formatting handles partial/blank names: ${expected}`, async () => {
        const f = setup(scope, mode, names);
        await f.run();
        assert.equal(f.renders[0].data.member_name, expected);
        assert.equal(f.renders[0].data.memberName, expected);
      });
    }
  }
}

for (const scope of ['member', 'organization']) {
  test(`rolling ${scope} recipient query errors remain explicit and stop delivery`, async () => {
    const f = setup(scope);
    // Only fail the recipient lookup, after history and successor checks.
    const from = f.db.from.bind(f.db);
    f.db.from = table => table !== 'member' ? from(table) : {
      select() { return this; }, eq() { return this; }, in() { return this; },
      maybeSingle() { return this; },
      then(resolve, reject) {
        return Promise.resolve({ data: null, error: { message: 'Fixture recipient read failed' } }).then(resolve, reject);
      },
    };
    await assert.rejects(f.run(), /Could not load (rolling reminder recipient|reminder recipients): Fixture recipient read failed/);
    assert.equal(f.effects.length, 0);
  });

  test(`rolling ${scope} paused recipients do not receive reminders`, async () => {
    const f = setup(scope);
    f.paused.add(scope === 'member' ? 'owner' : 'recipient');
    await f.run();
    assert.equal(f.effects.length, 0);
  });
}