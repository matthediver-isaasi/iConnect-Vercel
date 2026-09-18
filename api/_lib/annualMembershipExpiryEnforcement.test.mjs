import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

let root;
let sweep;
before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'expiry-sweep-'));
  const lib = path.join(root, 'api', '_lib');
  await mkdir(lib, { recursive: true });
  await mkdir(path.join(root, 'shared'));
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  for (const file of ['annualMembershipExpiryEnforcement.js', 'annualRenewalPolicy.js', 'membershipYear.js']) {
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