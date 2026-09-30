import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Install the existing fixed-overlay test seam before importing the permission
// helper: production roleVisibility otherwise primes its DB-backed overlay.
const previousSkipPrime = process.env.ROLE_ACCESS_OVERLAY_SKIP_PRIME;
process.env.ROLE_ACCESS_OVERLAY_SKIP_PRIME = '1';
const { __setRoleAccessOverlayForTests } = await import('./roleVisibility.js');
__setRoleAccessOverlayForTests([]);
const { applyResourceReadReleaseScope } = await import('./resourceReleaseAccess.js');
if (previousSkipPrime === undefined) delete process.env.ROLE_ACCESS_OVERLAY_SKIP_PRIME;
else process.env.ROLE_ACCESS_OVERLAY_SKIP_PRIME = previousSkipPrime;

const now = Date.parse('2026-06-01T12:00:00Z');
const groupId = '11111111-1111-4111-8111-111111111111';
const ctx = { isAuthenticated: true, tenantId: 'tenant', memberId: 'member', roleId: 'role' };
async function scope({ management = true, admin = false, context = {}, assignments = [], groups = [], fail = false } = {}) {
  const filters = [];
  const query = { eq(k, v) { filters.push([k, v]); return this; }, or(v) { filters.push(v); return this; } };
  const db = {
    from(table) {
      let data = table === 'member_group' ? groups : assignments;
      const q = {
        select() { return q; },
        eq(k, v) { data = data.filter(r => r[k] === v); return q; },
        in(k, values) { data = data.filter(r => values.includes(r[k])); return q; },
        then(resolve) { return Promise.resolve({ data, error: fail ? new Error('database failure') : null }).then(resolve); },
      };
      return q;
    },
  };
  await applyResourceReadReleaseScope({
    query, req: { query: management ? { resource_context: 'management' } : {} },
    ctx: { ...ctx, ...context }, db, hasAdminAccess: async () => admin, now,
  });
  return filters;
}
test('ordinary reads remain gated even for tenant admins; explicit management requires authority', async () => {
  assert.match((await scope({ management: false, admin: true }))[0], /release_date/);
  assert.match((await scope())[1], /release_date/);
  assert.deepEqual(await scope({ admin: true }), [['tenant_id', 'tenant']]);
  assert.match((await scope({ admin: true, context: { memberExcludedFeatures: ['admin.role-management'] } }))[1], /release_date/);
  assert.match((await scope({ admin: true, context: { isAuthenticated: false } }))[0], /release_date/);
  assert.match((await scope({ admin: true, context: { tenantMismatch: true } }))[0], /release_date/);
});
test('group management bypass is confined to live admin assignments and active same-tenant groups', async () => {
  const assignment = { group_id: groupId, member_id: 'member', is_group_admin: true, expires_at: null };
  const group = { id: groupId, tenant_id: 'tenant', is_active: true };
  assert.match((await scope({ assignments: [assignment], groups: [group] }))[1], /member_group_id.in/);
  for (const patch of [{ is_group_admin: false }, { member_id: 'other' }, { expires_at: 'invalid' }, { expires_at: '2026-06-01T12:00:00Z' }]) {
    assert.doesNotMatch((await scope({ assignments: [{ ...assignment, ...patch }], groups: [group] }))[1], /member_group_id/);
  }
  for (const patch of [{ tenant_id: 'other' }, { is_active: false }]) {
    assert.doesNotMatch((await scope({ assignments: [assignment], groups: [{ ...group, ...patch }] }))[1], /member_group_id/);
  }
  await assert.rejects(scope({ fail: true }), /database failure/);
});
test('both entity routes apply release constraints at query construction, before pagination', () => {
  for (const file of ['index.js', '[id].js']) {
    const code = readFileSync(new URL(`../entities/[entity]/${file}`, import.meta.url), 'utf8');
    assert.match(code, /const requestNow = Date.now\(\)/);
    assert.match(code, /\(\{ query \} = await applyResourceReadReleaseScope/);
    const range = code.indexOf('query.range(');
    if (range !== -1) assert.ok(code.indexOf('await applyResourceReadReleaseScope') < range);
  }
});
test('query scope excludes scheduled rows before exact count and paging, but allows verified management', async () => {
  const resources = [
    { id: 'future', tenant_id: 'tenant', release_date: '2026-06-02T12:00:00Z', target_url: 'secret' },
    { id: 'past', tenant_id: 'tenant', release_date: '2026-05-01T12:00:00Z' },
    { id: 'boundary', tenant_id: 'tenant', release_date: '2026-06-01T12:00:00Z' },
    { id: 'legacy', tenant_id: 'tenant', release_date: null },
    { id: 'foreign', tenant_id: 'other', release_date: null },
  ];
  async function run(management, admin) {
    const predicates = [];
    let start = 0, end = Infinity;
    const query = {
      eq(k, v) { predicates.push(row => row[k] === v); return this; },
      or(expression) {
        const prefix = 'release_date.is.null,release_date.lte.';
        assert.ok(expression.startsWith(prefix));
        const boundary = Date.parse(expression.slice(prefix.length));
        predicates.push(row => row.release_date === null || Date.parse(row.release_date) <= boundary);
        return this;
      },
      range(a, b) { start = a; end = b; return this; },
      then(resolve) {
        const matched = resources.filter(row => predicates.every(predicate => predicate(row)));
        return Promise.resolve({ data: matched.slice(start, end + 1), count: matched.length }).then(resolve);
      },
    };
    const { query: scoped } = await applyResourceReadReleaseScope({
      query, req: { query: management ? { resource_context: 'management' } : {} },
      ctx: { ...ctx, memberId: null }, now, hasAdminAccess: async () => admin,
      db: { from() { throw new Error('No group lookup expected for this roleless context'); } },
    });
    return await scoped.eq('tenant_id', 'tenant').range(0, 1);
  }
  for (const [management, admin] of [[false, false], [false, true], [true, false]]) {
    const result = await run(management, admin);
    assert.deepEqual(result.data.map(r => r.id), ['past', 'boundary']);
    assert.equal(result.count, 3);
    assert.equal(JSON.stringify(result).includes('secret'), false);
  }
  const management = await run(true, true);
  assert.deepEqual(management.data.map(r => r.id), ['future', 'past']);
  assert.equal(management.count, 4);
});