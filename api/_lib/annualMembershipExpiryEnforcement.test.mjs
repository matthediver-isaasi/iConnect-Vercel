import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildRollingCommitment } from './rollingMembershipCommitment.js';

let root;
let sweep;
before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'expiry-sweep-'));
  const lib = path.join(root, 'api', '_lib');
  await mkdir(lib, { recursive: true });
  await mkdir(path.join(root, 'shared'));
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  for (const file of ['annualMembershipExpiryEnforcement.js', 'annualRenewalPolicy.js', 'membershipYear.js', 'expiryOnlyRenewalPolicy.js']) {
    await cp(new URL(file, import.meta.url), path.join(lib, file));
  }
  await cp(new URL('../../shared/rollingMembershipTerm.js', import.meta.url), path.join(root, 'shared/rollingMembershipTerm.js'));
  await writeFile(path.join(lib, 'session.js'),
    'export const invalidateMemberSessions = () => { throw new Error("Real session effects forbidden"); };');
  ({ processTenantAnnualExpirySweep: sweep } = await import(pathToFileURL(path.join(lib, 'annualMembershipExpiryEnforcement.js'))));
});
after(async () => { await rm(root, { recursive: true, force: true }); });

// A hard response cap applies even to explicit limits. Queries and effects
// advance a deterministic clock; no network, environment credentials or providers.
function database(tables = {}, { cap = 1000, latency = 70, fail = () => false } = {}) {
  const state = { queries: [], elapsed: 0, tables, writes: [] };
  return Object.assign(state, {
    from(table) {
      const filters = [];
      let limit = cap;
      let sort = false;
      let operation = 'select';
      let payload;
      const chain = {
        select() { return this; },
        eq(key, value) { filters.push(row => row[key] === value); return this; },
        neq(key, value) { filters.push(row => row[key] !== value); return this; },
        is(key, value) { filters.push(row => value === null ? row[key] == null : row[key] === value); return this; },
        gt(key, value) { filters.push(row => row[key] > value); return this; },
        gte(key, value) { filters.push(row => row[key] >= value); return this; },
        lte(key, value) { filters.push(row => row[key] <= value); return this; },
        in(key, values) { filters.push(row => values.includes(row[key])); return this; },
        order() { sort = true; return this; },
        limit(value) { limit = Math.min(cap, value); return this; },
        update(value) { operation = 'update'; payload = value; return this; },
        insert(value) { operation = 'insert'; payload = value; return this; },
        run(single = false) {
          const query = { table, operation, payload };
          state.queries.push(query);
          state.elapsed += latency;
          if (fail(query, state)) return { data: null, error: { message: 'injected database failure' } };
          const rows = tables[table] ||= [];
          if (operation === 'insert') {
            const row = { id: `action-${rows.length}`, ...structuredClone(payload) };
            rows.push(row);
            state.writes.push(query);
            return { data: [structuredClone(row)], error: null };
          }
          let matches = rows.filter(row => filters.every(predicate => predicate(row)));
          if (sort) matches = matches.sort((a, b) => a.id.localeCompare(b.id));
          if (operation === 'update') {
            matches.forEach(row => Object.assign(row, payload));
            state.writes.push(query);
          }
          matches = matches.slice(0, limit);
          return { data: structuredClone(single ? matches[0] || null : matches), error: null };
        },
        maybeSingle() { return Promise.resolve(this.run(true)); },
        then(resolve, reject) { return Promise.resolve().then(() => this.run()).then(resolve, reject); },
      };
      return chain;
    },
  });
}
const now = new Date('2026-09-18T12:00:00Z');
const config = { id: 'config', tenant_id: 'tenant', billing_period: 'annual',
  renewal_disable_login: true, renewal_change_role: true, renewal_fallback_role_id: 'fallback' };
const history = (id = 'h-00000', extra = {}) => ({
  id, tenant_id: 'tenant', member_id: `m-${id}`, config_id: 'config',
  status: 'active', billing_period: 'annual', term_start_date: '2025-01-01',
  term_end_date: '2025-12-31', expiry_enforced_at: null, ...extra,
});
const member = (id, extra = {}) => ({
  id, tenant_id: 'tenant', login_enabled: true, role_id: 'original',
  organization_id: null, membership_paused: false, ...extra,
});
const rows = count => Array.from({ length: count }, (_, i) => history(`h-${String(i).padStart(5, '0')}`));
const tablesFor = histories => ({ member_membership_history: histories,
  membership_tier_config: [structuredClone(config)],
  member: histories.map(row => member(row.member_id)) });

const bnms = 'ff2df806-b321-4254-b651-3af11fccf1db';
const legacyExpiry = () => history('legacy', { tenant_id: bnms, config_id: null,
  membership_year: '2025/2026', payment_status: 'paid', payment_method: 'upfront',
  currency: 'GBP', tier_label: 'Reviewed tier', term_start_date: null,
  term_end_date: '2026-09-25', notes: JSON.stringify({ source: 'bnms_non_dd_current_backfill' }),
  final_cost: null, total_with_vat: null });

function assignedLegacyTables() {
  const legacy = legacyExpiry();
  return {
    member_membership_history: [legacy],
    member: [member(legacy.member_id, { tenant_id: bnms })],
    membership_tier_config: [{ ...config, tenant_id: bnms, start_mode: 'immediate',
      structure_scope_type: 'member', renewal_open_days: 90, renewal_grace_days: 90 }],
    membership_expiry_policy_assignment: [{
      id: 'authority', tenant_id: bnms, history_id: legacy.id, member_id: legacy.member_id,
      config_id: config.id, config_name: '2026-2027 Full member', expiry_date: '2026-09-25',
      approval_source: 'operator', policy_snapshot: {
        renewal_open_days: 90, renewal_grace_days: 90, renewal_disable_login: true,
        renewal_change_role: false, renewal_fallback_role_id: null,
      },
    }],
  };
}

function electedRecurringLegacyTables({ provider = 'gocardless', paymentStatus = 'paid' } = {}) {
  const tables = assignedLegacyTables();
  const legacy = tables.member_membership_history[0];
  const commitment = buildRollingCommitment({
    config: { ...tables.membership_tier_config[0], billing_period: 'annual' },
    startDate: '2026-09-26', paymentMethod: provider === 'stripe' ? 'card' : 'direct_debit',
    paymentFrequency: 'monthly',
    amounts: { annual_cost: 120, final_cost: 120, vat_amount: 0, total_with_vat: 120, currency: 'GBP' },
  });
  tables.member_membership_history.push({
    ...commitment, id: 'successor', tenant_id: bnms, member_id: legacy.member_id,
    status: 'active', payment_status: paymentStatus, billing_agreement_id: 'agreement',
    membership_successor_election_id: 'election', total_with_vat: 120, final_cost: 120,
    billing_period: 'monthly_direct_debit',
  });
  tables.membership_successor_election = [{
    id: 'election', tenant_id: bnms, member_id: legacy.member_id, previous_term_id: legacy.id,
    status: 'reserved', origin: 'form', payment_method: provider === 'stripe' ? 'monthly_card' : 'direct_debit',
    term_start_date: commitment.term_start_date, term_end_date: commitment.term_end_date,
  }];
  tables.membership_billing_agreements = [{
    id: 'agreement', tenant_id: bnms, member_id: legacy.member_id, provider, status: 'active',
    membership_successor_election_id: 'election',
    term_start_date: commitment.term_start_date, term_end_date: commitment.term_end_date,
  }];
  return tables;
}

for (const provider of ['gocardless', 'stripe']) {
  for (const paymentStatus of ['paid', 'partial']) {
    test(`${provider} ${paymentStatus}: elected active successor protects login at legacy grace end`, async () => {
      const tables = electedRecurringLegacyTables({ provider, paymentStatus });
      const before = structuredClone(tables);
      const db = database(tables, { cap: 1 });
      const result = await sweep(db, bnms, { details: [] }, new Date('2026-12-25'), {
        invalidateSessions: async () => assert.fail('Renewed member sessions must not be revoked'),
      });
      assert.equal(result.enforced, 0);
      assert.equal(tables.member[0].login_enabled, true);
      assert.equal(tables.member_membership_history[0].annual_renewal_state, 'renewed');
      const preserved = structuredClone(tables.member_membership_history[0]);
      delete preserved.annual_renewal_state;
      delete preserved.expiry_enforcement_key;
      preserved.expiry_enforced_at = null;
      assert.deepEqual(preserved, before.member_membership_history[0], 'historical dates, pricing and paid evidence are unchanged');
      assert.deepEqual(tables.member_membership_history[1], before.member_membership_history[1]);
      assert.deepEqual(tables.membership_billing_agreements, before.membership_billing_agreements);
      assert.deepEqual(tables.membership_successor_election, before.membership_successor_election);
      assert.equal(db.writes.some(write => ['member', 'membership_expiry_action'].includes(write.table)), false);
    });
  }
}

test('pending authorisation, unactivated payment and mismatched recurring successor authority do not protect legacy access', async () => {
  const mutations = [
    tables => { tables.member_membership_history[1].payment_status = 'unpaid'; },
    tables => { tables.member_membership_history[1].status = 'scheduled'; },
    tables => { tables.member_membership_history[1].status = 'pending_payment_setup'; },
    tables => { tables.member_membership_history[1].status = 'cancelled'; },
    tables => { tables.member_membership_history[1].membership_successor_election_id = null; },
    tables => { tables.member_membership_history[1].term_start_date = '2026-09-27'; },
    tables => { tables.member_membership_history[1].member_id = 'other'; },
    tables => { tables.member_membership_history[1].tenant_id = 'other'; },
    tables => { tables.member_membership_history[1].total_with_vat = null; tables.member_membership_history[1].final_cost = null; },
    tables => { tables.membership_successor_election[0].previous_term_id = 'other'; },
    tables => { tables.membership_successor_election[0].member_id = 'other'; },
    tables => { tables.membership_successor_election[0].tenant_id = 'other'; },
    tables => { tables.membership_successor_election[0].status = 'released'; },
    tables => { tables.membership_successor_election[0].payment_method = 'upfront'; },
    tables => { tables.membership_successor_election[0].term_end_date = '2027-09-26'; },
    tables => { tables.membership_billing_agreements[0].status = 'first_payment_pending'; },
    tables => { tables.membership_billing_agreements[0].status = 'cancelled'; },
    tables => { tables.membership_billing_agreements[0].member_id = 'other'; },
    tables => { tables.membership_billing_agreements[0].tenant_id = 'other'; },
    tables => { tables.membership_billing_agreements[0].membership_successor_election_id = 'other'; },
    tables => { tables.membership_billing_agreements[0].provider = 'other'; },
  ];
  for (const mutate of mutations) {
    const tables = electedRecurringLegacyTables();
    mutate(tables);
    const result = await sweep(database(tables), bnms, { details: [] }, new Date('2026-12-25'), {
      invalidateSessions: async () => ({ success: true }),
    });
    assert.equal(result.enforced, 1, String(mutate));
    assert.equal(tables.member[0].login_enabled, false, String(mutate));
  }
});

test('failed successor protection reads stop the sweep without disabling access', async () => {
  for (const table of ['membership_successor_election', 'membership_billing_agreements']) {
    const tables = electedRecurringLegacyTables(), before = structuredClone(tables);
    const db = database(tables, { fail: query => query.table === table });
    await assert.rejects(sweep(db, bnms, { details: [] }, new Date('2026-12-25')), /Could not verify expiry-only successor/);
    assert.deepEqual(tables.member, before.member);
    assert.deepEqual(tables.member_membership_history, before.member_membership_history);
    assert.deepEqual(db.writes, []);
  }
});

test('completed collection protects only a settled, still-current elected term', async () => {
  for (const paymentStatus of ['paid', 'partial']) {
    const tables = electedRecurringLegacyTables({ paymentStatus });
    tables.membership_billing_agreements[0].status = 'completed';
    const result = await sweep(database(tables), bnms, { details: [] }, new Date('2026-12-25'), {
      invalidateSessions: async () => ({ success: true }),
    });
    assert.equal(result.enforced, paymentStatus === 'paid' ? 0 : 1);
  }
  const tables = electedRecurringLegacyTables();
  const result = await sweep(database(tables), bnms, { details: [] }, new Date('2027-09-26'), {
    invalidateSessions: async () => ({ success: true }),
  });
  assert.equal(result.enforced, 1, 'an elapsed successor cannot extend access indefinitely');
});

test('operator expiry-only policy retains grace through Dec 24 and enforces Dec 25 without purchased-term changes', async () => {
  const tables = assignedLegacyTables(), db = database(tables);
  const legacy = tables.member_membership_history[0], original = structuredClone(legacy);
  const resolved = [];
  await sweep(db, bnms, { details: [] }, new Date('2026-12-24'), {
    cursor: { historyType: 'organisation' }, reviewHistoryIds: [legacy.id],
    reviewResolved: async id => resolved.push(id),
  });
  assert.deepEqual(resolved, [legacy.id]);
  assert.deepEqual(legacy, original);
  assert.equal(tables.member[0].login_enabled, true);
  assert.deepEqual(db.writes, []);
  const outcome = await sweep(db, bnms, { details: [] }, new Date('2026-12-25'), {
    invalidateSessions: async () => ({ success: true }),
  });
  assert.equal(outcome.enforced, 1);
  assert.equal(tables.member[0].login_enabled, false);
  assert.equal(tables.member[0].role_id, 'original');
  const preserved = structuredClone(legacy);
  delete preserved.annual_renewal_state;
  delete preserved.expiry_enforcement_key;
  preserved.expiry_enforced_at = null;
  assert.deepEqual(preserved, original);
  assert.equal(tables.membership_expiry_action[0].details.expiry_policy_assignment_id, 'authority');
  assert.equal(tables.membership_expiry_action[0].config_id, null, 'no historical purchase config is assigned');
});

test('mismatched assigned expiry cannot clear retained review or mutate access', async () => {
  const tables = assignedLegacyTables(), db = database(tables), resolved = [];
  tables.membership_expiry_policy_assignment[0].expiry_date = '2026-09-26';
  await assert.rejects(sweep(db, bnms, { details: [] }, new Date('2026-12-25'), {
    reviewHistoryIds: ['legacy'], reviewResolved: async id => resolved.push(id),
  }), /binding.*invalid/);
  assert.deepEqual(resolved, []);
  assert.deepEqual(db.writes, []);
});

test('attested expiry-only history records durable actionable review before advancing to valid rows', async () => {
  const legacy = legacyExpiry(), original = structuredClone(legacy);
  const valid = history('valid', { tenant_id: bnms });
  const db = database({ member_membership_history: [legacy, valid],
    membership_tier_config: [{ ...config, tenant_id: bnms }],
    member: [member(valid.member_id, { tenant_id: bnms })] });
  const results = { details: [] }, checkpoints = [], retained = [];
  const outcome = await sweep(db, bnms, results, new Date('2026-09-27'), {
    invalidateSessions: async () => ({ success: true }),
    reviewRequired: async id => {
      assert.ok(db.tables.scheduled_task_log?.length, 'review log must precede durable identity');
      retained.push(id);
    },
    checkpoint: async cursor => {
      checkpoints.push(structuredClone(cursor));
      assert.ok(db.tables.scheduled_task_log?.length, 'review must precede cursor advance');
      assert.deepEqual(retained, [legacy.id], 'durable identity must precede cursor advance');
    },
  });
  assert.equal(outcome.complete, true);
  assert.equal(outcome.examined, 2);
  assert.equal(outcome.enforced, 1);
  assert.deepEqual(legacy, original, 'legacy history/expiry/date evidence is never rewritten');
  assert.equal(results.errors, 1, 'review is not a healthy heartbeat');
  assert.equal(results.details[0].status, 'review_required');
  const log = db.tables.scheduled_task_log[0];
  assert.equal(log.status, 'error');
  assert.equal(JSON.parse(log.details).details[0].historyId, legacy.id);
  assert.match(JSON.parse(log.details).details[0].reason, /access policy authority/);
  assert.ok(checkpoints.some(cursor => cursor.afterId === valid.id));
});

test('review-log write failure preserves the cursor and does not change legacy access', async () => {
  const legacy = legacyExpiry(), checkpoints = [];
  const db = database({ member_membership_history: [legacy] }, {
    fail: query => query.table === 'scheduled_task_log' && query.operation === 'insert',
  });
  await assert.rejects(sweep(db, bnms, { details: [] }, new Date('2026-09-27'), {
    checkpoint: async cursor => checkpoints.push(cursor),
  }), /Could not record legacy expiry policy review/);
  assert.deepEqual(checkpoints, []);
  assert.deepEqual(db.writes, []);
  assert.equal(legacy.expiry_enforced_at, null);
});

test('retained review resolves only after assigned explicit policy passes normal expiry processing', async () => {
  const legacy = legacyExpiry();
  const db = database({ member_membership_history: [legacy],
    member: [member(legacy.member_id, { tenant_id: bnms })] });
  const resolved = [];
  const options = {
    cursor: { historyType: 'organisation', afterId: null },
    reviewHistoryIds: [legacy.id],
    reviewResolved: async id => resolved.push(id),
    invalidateSessions: async () => ({ success: true }),
  };
  const date = new Date('2026-09-27');
  await sweep(db, bnms, { details: [] }, date, options);
  assert.deepEqual(resolved, [], 'unknown policy stays unresolved after traversal');
  legacy.config_id = 'repaired';
  db.tables.membership_tier_config = [{ ...config, id: 'repaired', tenant_id: bnms }];
  await sweep(db, bnms, { details: [] }, date, options);
  assert.deepEqual(resolved, [], 'absent explicit grace setting cannot clear review');
  db.tables.membership_tier_config[0].renewal_grace_days = 0;
  await sweep(db, bnms, { details: [] }, date, options);
  assert.deepEqual(resolved, [legacy.id]);
  assert.ok(legacy.expiry_enforced_at);
  assert.equal(db.tables.member[0].login_enabled, false);
  assert.equal(legacy.term_start_date, null);
});

test('failed repaired-policy enforcement and missing history never clear a retained review', async () => {
  for (const missing of [false, true]) {
    const legacy = { ...legacyExpiry(), config_id: 'repaired' }, resolved = [];
    const db = database({ member_membership_history: missing ? [] : [legacy],
      membership_tier_config: [{ ...config, id: 'repaired', tenant_id: bnms, renewal_grace_days: 0 }],
      member: [member(legacy.member_id, { tenant_id: bnms })] }, {
      fail: query => query.table === 'membership_expiry_action' && query.operation === 'insert',
    });
    await assert.rejects(sweep(db, bnms, { details: [] }, new Date('2026-09-27'), {
      cursor: { historyType: 'organisation', afterId: null }, reviewHistoryIds: [legacy.id],
      reviewResolved: async id => resolved.push(id),
    }), missing ? /review history missing/ : /prepare expiry journal/i);
    assert.deepEqual(resolved, []);
  }
});

test('review revalidation is batched across server caps and explicit no-access policy resolves without effects', async () => {
  const histories = Array.from({ length: 100 }, (_, i) => ({
    ...legacyExpiry(), id: `review-${String(i).padStart(3, '0')}`,
  }));
  const db = database({ member_membership_history: histories }, { cap: 37 });
  const resolved = [];
  const options = { cursor: { historyType: 'organisation' },
    reviewHistoryIds: histories.map(row => row.id),
    reviewResolved: async id => resolved.push(id) };
  const date = new Date('2026-09-27');
  await sweep(db, bnms, { details: [] }, date, options);
  assert.deepEqual(resolved, []);
  assert.equal(db.queries.filter(q => q.table === 'member_membership_history').length, 4);
  histories[0].config_id = 'disabled';
  db.tables.membership_tier_config = [{ ...config, id: 'disabled', tenant_id: bnms,
    renewal_disable_login: false, renewal_change_role: false, renewal_grace_days: 0 }];
  await sweep(db, bnms, { details: [] }, date, options);
  assert.deepEqual(resolved, [histories[0].id]);
  assert.deepEqual(db.writes, []);
});

test('missing modern policy and unproven legacy shape are still errors, not review skips', async () => {
  for (const extra of [{ notes: null }, { config_id: 'deleted' }, { term_key: 'rolling' },
    { term_start_date: '2025-09-26' }, { payment_method: 'direct_debit' },
    { tenant_id: 'other' }, { term_end_date: '2026-02-30' }]) {
    const legacy = { ...legacyExpiry(), ...extra };
    const db = database({ member_membership_history: [legacy] });
    await assert.rejects(sweep(db, legacy.tenant_id, { details: [] }, new Date('2026-09-27')),
      /Expiry policy missing/);
    assert.deepEqual(db.writes, []);
  }
});

test('868 observed candidates: batched policy reads remove N+1 latency, including checkpoint writes', async t => {
  const db = database({ member_membership_history: rows(868),
    membership_tier_config: [{ ...config, renewal_disable_login: false, renewal_change_role: false }] });
  let checkpoints = 0;
  const result = await sweep(db, 'tenant', null, now, {
    checkpoint: async () => { checkpoints++; db.elapsed += 70; },
  });
  const configReads = db.queries.filter(q => q.table === 'membership_tier_config').length;
  const beforeQueries = 868 + 3; // old paused-set + two unpaged history reads + one policy read per row
  assert.equal(result.examined, 868);
  assert.equal(result.complete, true);
  assert.equal(configReads, 2); // one bounded batch + terminal empty page
  assert.ok(db.elapsed < 3000);
  assert.ok(checkpoints < 15);
  t.diagnostic(`Simulated 70ms/query: before ${beforeQueries} queries/${beforeQueries * 70}ms; after ${db.queries.length} queries + ${checkpoints} checkpoints/${db.elapsed}ms. Policy-disabled fixture isolates the historical N+1 stage, not a production timing claim.`);
});

test('keyset traversal exceeds default cap across both history types, even with lower server cap', async () => {
  const db = database({ member_membership_history: rows(1205),
    organisation_membership_history: rows(1131).map(row => ({ ...row, organization_id: 'org' })),
    membership_tier_config: [{ ...config, renewal_disable_login: false, renewal_change_role: false }] }, { cap: 37 });
  const result = await sweep(db, 'tenant', null, now);
  assert.equal(result.examined, 2336);
  assert.equal(result.complete, true);
  assert.equal(db.queries.filter(q => q.table === 'membership_tier_config').length, 2);
});

test('snapshots win over missing/live policies and recurring and future histories need no config reads', async () => {
  const histories = [
    history('snapshot', { config_id: 'missing', commitment_snapshot: { config: {
      ...config, renewal_disable_login: false, renewal_change_role: false,
    } } }),
    history('monthly', { billing_period: 'monthly_card' }),
    history('future', { term_end_date: '2027-12-31' }),
  ];
  const db = database({ member_membership_history: histories });
  assert.equal((await sweep(db, 'tenant', null, now)).examined, 3);
  assert.equal(db.queries.some(q => q.table === 'membership_tier_config'), false);
  assert.equal(db.writes.length, 0);
});

test('snapshot expiry policy applies despite live disabled policy and preserves provenance before effects', async () => {
  const row = history('snapshot', { commitment_snapshot: { config } });
  const tables = tablesFor([row]);
  tables.membership_tier_config = [{ ...config, renewal_disable_login: false, renewal_change_role: false }];
  const db = database(tables);
  let invalidations = 0;
  const result = await sweep(db, 'tenant', null, now, { invalidateSessions: async () => {
    invalidations++;
    assert.equal(tables.membership_expiry_action[0].previous_role_id, 'original');
    return { success: true };
  } });
  assert.equal(result.enforced, 1);
  assert.equal(invalidations, 1);
  assert.equal(db.writes[0].table, 'membership_expiry_action');
  assert.equal(tables.member[0].login_enabled, false);
  assert.equal(tables.member[0].role_id, 'fallback');
  assert.equal(tables.membership_expiry_action[0].action_state, 'completed');
  assert.equal(db.queries.some(q => q.table === 'membership_tier_config'), false);
});

test('budget yields before queries, checkpoints exact safe cursor, then resumes', async () => {
  const db = database({ member_membership_history: rows(250),
    membership_tier_config: [{ ...config, renewal_disable_login: false, renewal_change_role: false }] });
  let cursor;
  const first = await sweep(db, 'tenant', null, now, {
    shouldContinue: () => db.elapsed < 300,
    checkpoint: async value => { cursor = structuredClone(value); },
  });
  assert.equal(first.complete, false);
  assert.deepEqual(first.cursor, cursor);
  assert.ok(db.elapsed < 400);
  const second = await sweep(db, 'tenant', null, now, { cursor });
  assert.equal(second.complete, true);
  assert.equal(first.examined + second.examined, 250);
});

test('large organisation fanout resumes per member and completed actions are not replayed', async () => {
  const tables = { organisation_membership_history: [history('org-history', { organization_id: 'org' })],
    membership_tier_config: [structuredClone(config)],
    member: Array.from({ length: 1031 }, (_, i) => member(`m-${String(i).padStart(5, '0')}`, { organization_id: 'org' })) };
  const db = database(tables, { cap: 37, latency: 1 });
  const calls = new Map();
  let cursor;
  const invalidateSessions = async id => { calls.set(id, (calls.get(id) || 0) + 1); return { success: true }; };
  const first = await sweep(db, 'tenant', null, now, {
    shouldContinue: () => calls.size < 45, invalidateSessions,
    checkpoint: async next => { cursor = structuredClone(next); },
  });
  assert.equal(first.complete, false);
  assert.equal(cursor.historyId, 'org-history');
  const result = await sweep(db, 'tenant', null, now, { cursor, invalidateSessions });
  assert.equal(result.complete, true);
  assert.equal(calls.size, 1031);
  // Last invalidation can precede a budget stop at completion-journal write.
  assert.ok([...calls.values()].filter(value => value > 1).length <= 1);
  assert.equal(tables.membership_expiry_action.length, 1031);
  const before = [...calls];
  await sweep(db, 'tenant', null, now, { invalidateSessions });
  assert.deepEqual([...calls], before);
});

test('interruption after mutation repairs from original journal; complete action survives failed history mark', async () => {
  const row = history();
  const tables = tablesFor([row]);
  let failSessions = true;
  let failHistory = false;
  let invalidations = 0;
  const db = database(tables, { fail: q => failHistory && q.table === 'member_membership_history' && q.operation === 'update' });
  const invalidateSessions = async () => {
    invalidations++;
    if (failSessions) throw new Error('interrupted session effect');
    return { success: true };
  };
  await assert.rejects(sweep(db, 'tenant', null, now, { invalidateSessions }), /interrupted/);
  const original = structuredClone(tables.membership_expiry_action[0]);
  assert.equal(original.previous_login_enabled, true);
  assert.equal(original.previous_role_id, 'original');
  assert.equal(original.action_state, 'pending');
  assert.equal(tables.member[0].role_id, 'fallback');
  failSessions = false;
  failHistory = true;
  await assert.rejects(sweep(db, 'tenant', null, now, { invalidateSessions }), /complete expiry history/);
  assert.equal(tables.membership_expiry_action[0].action_state, 'completed');
  const count = invalidations;
  failHistory = false;
  assert.equal((await sweep(db, 'tenant', null, now, { invalidateSessions })).complete, true);
  assert.equal(invalidations, count);
  const repaired = tables.membership_expiry_action[0];
  for (const key of ['previous_login_enabled', 'previous_role_id', 'applied_at']) assert.equal(repaired[key], original[key]);
});

test('journal failure prevents mutations; protection query failures never advance history', async () => {
  for (const failingTable of ['membership_expiry_action', 'role', 'organisation_membership_history']) {
    const tables = tablesFor([history()]);
    tables.member[0].organization_id = 'org';
    const db = database(tables, { fail: q => q.table === failingTable });
    await assert.rejects(sweep(db, 'tenant', null, now), /injected database failure/);
    assert.equal(tables.member[0].login_enabled, true);
    assert.equal(tables.member_membership_history[0].expiry_enforced_at, null);
    assert.equal(db.writes.length, 0);
  }
});

test('pause, admin, successful successor, inherited and individual protections fail closed', async () => {
  for (const protection of ['pause', 'admin', 'successor', 'inherited', 'individual']) {
    const row = history();
    const tables = tablesFor([row]);
    if (protection === 'pause') tables.member[0].membership_paused = true;
    if (protection === 'admin') tables.role = [{ id: 'original', tenant_id: 'tenant', is_tenant_admin: true }];
    if (protection === 'successor') tables.member_membership_history.push(history('next', {
      member_id: row.member_id, term_start_date: '2026-01-01', term_end_date: '2026-12-31',
      payment_status: 'paid',
    }));
    if (protection === 'inherited') {
      tables.member[0].organization_id = 'org';
      tables.organisation_membership_history = [history('inherited', {
        organization_id: 'org', term_start_date: '2026-01-01', term_end_date: '2026-12-31',
      })];
    }
    if (protection === 'individual') {
      tables.member[0].organization_id = 'org';
      row.term_end_date = '2026-12-31';
      tables.organisation_membership_history = [history('expired-org', { organization_id: 'org' })];
    }
    const db = database(tables);
    await sweep(db, 'tenant', null, now);
    assert.equal(tables.member[0].login_enabled, true, protection);
    assert.equal(tables.membership_expiry_action?.length || 0, 0, protection);
  }
});

test('renewed-term protection scans beyond unpaid rows and database cap', async () => {
  const prior = history();
  const tables = tablesFor([prior]);
  tables.member_membership_history.push(...rows(121).map((row, i) => ({
    ...row, id: `next-${row.id}`, member_id: prior.member_id,
    term_start_date: '2026-01-01', term_end_date: '2026-12-31',
    final_cost: 100, payment_status: i === 120 ? 'paid' : 'unpaid',
  })));
  const db = database(tables, { cap: 37 });
  await sweep(db, 'tenant', null, now);
  assert.equal(prior.annual_renewal_state, 'renewed');
  assert.equal(tables.member[0].login_enabled, true);
});

test('checkpoint failure is a real error and budget-before-start performs no queries', async () => {
  const db = database();
  const result = await sweep(db, 'tenant', null, now, { shouldContinue: () => false });
  assert.equal(result.complete, false);
  assert.equal(db.queries.length, 0);
  await assert.rejects(sweep(db, 'tenant', null, now, {
    shouldContinue: () => false, checkpoint: async () => { throw new Error('checkpoint failed'); },
  }), /checkpoint failed/);
});

test('missing and cross-tenant live configurations fail closed, while distinct IDs are batched', async () => {
  for (const policies of [[], [{ ...config, tenant_id: 'other' }]]) {
    const tables = tablesFor([history()]);
    tables.membership_tier_config = policies;
    const db = database(tables);
    await assert.rejects(sweep(db, 'tenant', null, now), /Expiry policy missing/);
    assert.equal(db.writes.length, 0);
  }
  const policies = Array.from({ length: 150 }, (_, i) => ({
    ...config, id: `config-${String(i).padStart(3, '0')}`, renewal_disable_login: false, renewal_change_role: false,
  }));
  const histories = rows(450).map((row, i) => ({ ...row, config_id: policies[i % 150].id }));
  const db = database({ member_membership_history: histories, membership_tier_config: policies }, { cap: 37 });
  assert.equal((await sweep(db, 'tenant', null, now)).examined, 450);
  assert.ok(db.queries.filter(q => q.table === 'membership_tier_config').length <= 10);
});

test('legacy rolling history stays review-only; trusted upfront monthly expiry keeps saved boundary', async () => {
  const legacy = tablesFor([history()]);
  legacy.membership_tier_config[0].start_mode = 'immediate';
  const results = { details: [], processed: 0 };
  const legacyDb = database(legacy);
  await sweep(legacyDb, 'tenant', results, now);
  assert.equal(results.details[0].status, 'review_required');
  assert.equal(legacyDb.writes.length, 0);
  const rollingConfig = { ...config, start_mode: 'immediate', billing_period: 'monthly' };
  const row = history('rolling', {
    term_key: 'rolling:2026-08-01', term_start_date: '2026-08-01', term_end_date: '2026-08-31',
    membership_renewal_date: '2026-09-01', billing_period: 'monthly',
    commitment_snapshot: { start_mode: 'immediate', payment_frequency: 'upfront', config: rollingConfig },
  });
  const tables = tablesFor([row]);
  const db = database(tables);
  const result = await sweep(db, 'tenant', null, now, { invalidateSessions: async () => ({ success: true }) });
  assert.equal(result.enforced, 1);
  assert.equal(row.term_start_date, '2026-08-01');
  assert.equal(row.membership_renewal_date, '2026-09-01');
});

test('transport slice exhaustion checkpoints progress, but ordinary read aborts remain failures', async () => {
  const checkpoints = [];
  const db = database({ member_membership_history: [
    { id: 'first', tenant_id: 'tenant', status: 'cancelled' },
  ] }, { fail: (_query, state) => {
    if (state.queries.length === 2) throw Object.assign(new Error('slice ended'), { code: 'RENEWAL_BUDGET_EXHAUSTED' });
    return false;
  } });
  const result = await sweep(db, 'tenant', null, now, {
    checkpoint: async cursor => checkpoints.push(structuredClone(cursor)),
  });
  assert.equal(result.complete, false);
  assert.equal(result.examined, 1);
  assert.deepEqual(result.cursor, { historyType: 'member', afterId: 'first' });
  assert.deepEqual(checkpoints.at(-1), result.cursor);
  assert.equal(db.writes.length, 0);
  const broken = database({}, { fail: () => { throw new Error('AbortError: independent read timeout'); } });
  await assert.rejects(sweep(broken, 'tenant', null, now), /independent read timeout/);
});

test('pending journal never overwrites a later unrelated manual role change', async () => {
  const row = history();
  const tables = tablesFor([row]);
  const db = database(tables);
  await assert.rejects(sweep(db, 'tenant', null, now, {
    invalidateSessions: async () => { throw new Error('interruption'); },
  }), /interruption/);
  tables.member[0].role_id = 'manually-chosen';
  await sweep(db, 'tenant', null, now, { invalidateSessions: async () => ({ success: true }) });
  assert.equal(tables.member[0].role_id, 'manually-chosen');
  assert.equal(tables.membership_expiry_action[0].previous_role_id, 'original');
});