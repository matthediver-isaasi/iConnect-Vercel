import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchMemberJobTitlesByEmail, resolveStoredJobTitle } from './attendeeJobTitleEnrichment.js';

// Fake supabase client: case-insensitive ilike email matching against a fixture
// member table, mimicking PostgREST behaviour for the query shape the helper uses.
function makeFakeSupabase(members) {
  return {
    from(table) {
      assert.equal(table, 'member');
      const state = {};
      const builder = {
        select() { return builder; },
        eq(col, val) { state[col] = val; return builder; },
        ilike(col, pattern) { state.ilikeCol = col; state.ilikePattern = pattern; return builder; },
        limit() {
          // Unescape literal-escaped LIKE wildcards, then compare case-insensitively.
          const literal = state.ilikePattern.replace(/\\([\\%_])/g, '$1');
          const data = members.filter(
            (m) =>
              m.tenant_id === state.tenant_id &&
              (m.email || '').toLowerCase() === literal.toLowerCase()
          );
          return Promise.resolve({ data, error: null });
        }
      };
      return builder;
    }
  };
}

const MEMBERS = [
  { tenant_id: 't1', email: 'A.R.Hirst@leeds.ac.uk', job_title: 'Visiting Research Fellow' },
  { tenant_id: 't1', email: 'chloe@example.com', job_title: 'Career Coach' },
  { tenant_id: 't1', email: 'untitled@example.com', job_title: '   ' },
  { tenant_id: 't2', email: 'chloe@example.com', job_title: 'Other Tenant Title' }
];

test('matches member emails case-insensitively (mixed-case stored member email)', async () => {
  const map = await fetchMemberJobTitlesByEmail(makeFakeSupabase(MEMBERS), 't1', ['a.r.hirst@leeds.ac.uk']);
  assert.equal(map.get('a.r.hirst@leeds.ac.uk'), 'Visiting Research Fellow');
});

test('matches when the ATTENDEE email is mixed-case', async () => {
  const map = await fetchMemberJobTitlesByEmail(makeFakeSupabase(MEMBERS), 't1', ['CHLOE@Example.COM']);
  assert.equal(map.get('chloe@example.com'), 'Career Coach');
});

test('is tenant-scoped and excludes members with blank/whitespace titles', async () => {
  const map = await fetchMemberJobTitlesByEmail(makeFakeSupabase(MEMBERS), 't1', [
    'chloe@example.com',
    'untitled@example.com'
  ]);
  assert.equal(map.get('chloe@example.com'), 'Career Coach'); // t1 title, not t2's
  assert.equal(map.has('untitled@example.com'), false);
});

test('returns empty map without tenant or emails', async () => {
  assert.equal((await fetchMemberJobTitlesByEmail(makeFakeSupabase(MEMBERS), null, ['x@y.com'])).size, 0);
  assert.equal((await fetchMemberJobTitlesByEmail(makeFakeSupabase(MEMBERS), 't1', [])).size, 0);
  assert.equal((await fetchMemberJobTitlesByEmail(makeFakeSupabase(MEMBERS), 't1', ['not-an-email'])).size, 0);
});

test('resolveStoredJobTitle: explicit title always wins', () => {
  const map = new Map([['chloe@example.com', 'Career Coach']]);
  assert.equal(resolveStoredJobTitle('CTO', 'chloe@example.com', map), 'CTO');
  assert.equal(resolveStoredJobTitle('  CTO  ', 'chloe@example.com', map), 'CTO');
});

test('resolveStoredJobTitle: blank/whitespace explicit falls back to member profile', () => {
  const map = new Map([['chloe@example.com', 'Career Coach']]);
  assert.equal(resolveStoredJobTitle('', 'chloe@example.com', map), 'Career Coach');
  assert.equal(resolveStoredJobTitle('   ', 'Chloe@Example.com', map), 'Career Coach');
  assert.equal(resolveStoredJobTitle(null, 'chloe@example.com', map), 'Career Coach');
});

test('resolveStoredJobTitle: non-member attendee stays null', () => {
  const map = new Map([['chloe@example.com', 'Career Coach']]);
  assert.equal(resolveStoredJobTitle('', 'guest@example.com', map), null);
  assert.equal(resolveStoredJobTitle('', 'guest@example.com', null), null);
});
