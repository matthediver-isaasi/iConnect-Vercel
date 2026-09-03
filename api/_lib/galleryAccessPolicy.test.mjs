import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { evaluateGalleryAccessPolicy, normalizeGalleryAccessPolicy, validateGalleryAccessPolicy } from './galleryAccessPolicy.js';

const policy = (groups) => ({ version: 1, groups });

// A deliberately fluent fake: it applies the same eq/in/is/not predicates the
// policy code sends to Supabase, which catches accidental loss of tenant or
// confirmation/reversal constraints.
function fakeSupabase(seed) {
  const makeQuery = (table) => {
    const filters = [];
    const query = {
      select() { return query; },
      eq(column, value) { filters.push((row) => row[column] === value); return query; },
      in(column, values) { filters.push((row) => values.includes(row[column])); return query; },
      is(column, value) { filters.push((row) => row[column] === value); return query; },
      not(column, operator, value) {
        assert.equal(operator, 'is');
        filters.push((row) => value === null ? row[column] !== null && row[column] !== undefined : row[column] !== value);
        return query;
      },
      then(resolve, reject) {
        return Promise.resolve({ data: (seed[table] || []).filter((row) => filters.every((filter) => filter(row))) }).then(resolve, reject);
      },
    };
    return query;
  };
  return { from: makeQuery };
}

const seed = {
  member_group: [{ id: 'group', tenant_id: 't1', is_active: true }, { id: 'inactive', tenant_id: 't1', is_active: false }],
  role: [{ id: 'role', tenant_id: 't1' }, { id: 'other-tenant-role', tenant_id: 't2' }],
  event: [{ id: 'simple', tenant_id: 't1' }],
  complex_event: [{ id: 'complex', tenant_id: 't1' }],
  member_group_assignment: [
    { tenant_id: 't1', member_id: 'member', group_id: 'group', expires_at: null },
    { tenant_id: 't1', member_id: 'expired', group_id: 'group', expires_at: '2020-01-01T00:00:00Z' },
  ],
  booking: [
    { tenant_id: 't1', member_id: 'simple-member', event_id: 'simple', status: 'confirmed', checked_in_at: '2026-01-01', check_in_reversed_at: null },
    { tenant_id: 't1', member_id: 'cancelled', event_id: 'simple', status: 'cancelled', checked_in_at: '2026-01-01', check_in_reversed_at: null },
    { tenant_id: 't1', member_id: 'reversed', event_id: 'simple', status: 'confirmed', checked_in_at: '2026-01-01', check_in_reversed_at: '2026-01-02' },
  ],
  complex_event_booking: [
    { id: 'complex-booking', tenant_id: 't1', member_id: 'complex-member', complex_event_id: 'complex', status: 'confirmed' },
    { id: 'complex-cancelled', tenant_id: 't1', member_id: 'complex-cancelled', complex_event_id: 'complex', status: 'cancelled' },
    { id: 'complex-reversed', tenant_id: 't1', member_id: 'complex-reversed', complex_event_id: 'complex', status: 'confirmed' },
  ],
  complex_event_session_checkin: [
    { tenant_id: 't1', booking_id: 'complex-booking', checked_in_at: '2026-01-01', check_in_reversed_at: null },
    { tenant_id: 't1', booking_id: 'complex-cancelled', checked_in_at: '2026-01-01', check_in_reversed_at: null },
    { tenant_id: 't1', booking_id: 'complex-reversed', checked_in_at: '2026-01-01', check_in_reversed_at: '2026-01-02' },
  ],
};

test('normalizes only canonical versioned OR groups with AND conditions', () => {
  const result = normalizeGalleryAccessPolicy(policy([
    { conditions: [{ type: 'member_group', id: ' group ' }, { type: 'event', event_type: 'complex', id: 'complex' }] },
  ]));
  assert.deepEqual(result.policy, policy([{ conditions: [{ type: 'member_group', id: 'group' }, { type: 'event', event_type: 'complex', id: 'complex' }] }]));
  assert.equal(normalizeGalleryAccessPolicy([{ conditions: [] }]).ok, false);
  assert.equal(normalizeGalleryAccessPolicy(policy([{ conditions: [{ type: 'event', id: 'simple' }] }])).ok, false);
});

test('validates tenant-scoped active group, role, simple and complex references', async () => {
  const sb = fakeSupabase(seed);
  assert.equal((await validateGalleryAccessPolicy({ supabase: sb, tenantId: 't1', policy: policy([{ conditions: [{ type: 'member_group', id: 'inactive' }] }] ) })).ok, false);
  assert.equal((await validateGalleryAccessPolicy({ supabase: sb, tenantId: 't1', policy: policy([{ conditions: [{ type: 'role', id: 'other-tenant-role' }] }] ) })).ok, false);
  assert.equal((await validateGalleryAccessPolicy({ supabase: sb, tenantId: 't1', policy: policy([{ conditions: [{ type: 'event', event_type: 'simple', id: 'complex' }] }] ) })).ok, false);
});

test('evaluates nested OR groups and AND conditions, including exact role and expiry', async () => {
  const sb = fakeSupabase(seed);
  const access = policy([
    { conditions: [{ type: 'member_group', id: 'group' }, { type: 'role', id: 'role' }] },
    { conditions: [{ type: 'event', event_type: 'simple', id: 'simple' }] },
  ]);
  assert.equal((await evaluateGalleryAccessPolicy({ supabase: sb, tenantId: 't1', memberId: 'member', roleId: 'role', policy: access })).allowed, true);
  assert.equal((await evaluateGalleryAccessPolicy({ supabase: sb, tenantId: 't1', memberId: 'member', roleId: 'not-role', policy: access })).allowed, false);
  assert.equal((await evaluateGalleryAccessPolicy({ supabase: sb, tenantId: 't1', memberId: 'expired', roleId: 'role', policy: policy([{ conditions: [{ type: 'member_group', id: 'group' }] }]), now: Date.parse('2026-01-01') })).allowed, false);
});

test('requires confirmed non-reversed simple and complex attendance', async () => {
  const sb = fakeSupabase(seed);
  const simple = policy([{ conditions: [{ type: 'event', event_type: 'simple', id: 'simple' }] }]);
  assert.equal((await evaluateGalleryAccessPolicy({ supabase: sb, tenantId: 't1', memberId: 'simple-member', policy: simple })).allowed, true);
  assert.equal((await evaluateGalleryAccessPolicy({ supabase: sb, tenantId: 't1', memberId: 'cancelled', policy: simple })).allowed, false);
  assert.equal((await evaluateGalleryAccessPolicy({ supabase: sb, tenantId: 't1', memberId: 'reversed', policy: simple })).allowed, false);
  const complex = policy([{ conditions: [{ type: 'event', event_type: 'complex', id: 'complex' }] }]);
  assert.equal((await evaluateGalleryAccessPolicy({ supabase: sb, tenantId: 't1', memberId: 'complex-member', policy: complex })).allowed, true);
  assert.equal((await evaluateGalleryAccessPolicy({ supabase: sb, tenantId: 't1', memberId: 'complex-cancelled', policy: complex })).allowed, false);
  assert.equal((await evaluateGalleryAccessPolicy({ supabase: sb, tenantId: 't1', memberId: 'complex-reversed', policy: complex })).allowed, false);
});

test('entity gallery authorization constrains the database before pagination and count', () => {
  const source = readFileSync(new URL('../entities/[entity]/index.js', import.meta.url), 'utf8');
  const authorization = source.indexOf('Resolve gallery access before adding pagination/count clauses');
  const pagination = source.indexOf('if (limit) query = query.limit');
  assert.ok(authorization >= 0 && authorization < pagination);
  assert.match(source, /query = query\.in\(entityNorm === 'gallery' \? 'id' : 'gallery_id', allowedGalleryIds\)/);
  assert.match(source, /return wantsCount \? res\.json\(\{ data: \[\], count: 0 \}\) : res\.json\(\[\]\)/);
  const galleryBlock = source.slice(authorization, source.indexOf('// Existing core-field callers', authorization));
  assert.doesNotMatch(galleryBlock, /hasAdminAccess/);
});

test('gallery visibility transition is owned by the migration endpoint', () => {
  const entitySource = readFileSync(new URL('../entities/[entity]/[id].js', import.meta.url), 'utf8');
  const migrationSource = readFileSync(new URL('../galleries/migrate-bucket.js', import.meta.url), 'utf8');
  const editorSource = readFileSync(new URL('../../client/src/pages/PhotoGalleries.jsx', import.meta.url), 'utf8');
  assert.match(entitySource, /Gallery visibility must be changed with \/api\/galleries\/migrate-bucket/);
  assert.match(migrationSource, /target_is_public must be a boolean/);
  assert.match(migrationSource, /update\(\{ is_public: true, access_policy: null \}\)/);
  assert.match(migrationSource, /update\(\{ is_public: false \}\)/);
  assert.match(
    migrationSource,
    /if \(delErr\) \{[\s\S]*return \{ error: delErr\.message \|\| 'source delete failed' \};/,
  );
  assert.match(editorSource, /return base44\.entities\.Gallery\.get\(gallery\.id\)/);
  assert.doesNotMatch(editorSource, /Gallery\.update\(gallery\.id, \{ is_public:/);
});