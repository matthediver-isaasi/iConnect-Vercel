import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRobotsTenant } from './robots.txt.js';

// Fake supabase client with a fixed tenant table keyed by slug.
function fakeClient(tenantsBySlug) {
  return {
    from() {
      const filters = {};
      const chain = {
        select() { return chain; },
        eq(col, val) { filters[col] = val; return chain; },
        async single() {
          if (filters.slug && filters.status === 'active') {
            const t = tenantsBySlug[filters.slug];
            return t ? { data: t, error: null } : { data: null, error: { message: 'not found' } };
          }
          if (filters.domain) {
            const t = Object.values(tenantsBySlug).find((x) => x.domain === filters.domain);
            return t ? { data: t, error: null } : { data: null, error: { message: 'not found' } };
          }
          return { data: null, error: { message: 'not found' } };
        },
      };
      return chain;
    },
  };
}

const tenants = {
  gfi: { id: '1', slug: 'gfi', settings: {} },
  other: { id: '2', slug: 'other', settings: {}, domain: 'members.example.org' },
};

test('mismatched ?tenant= on {slug}.iconn.app resolves the HOST tenant', async () => {
  const t = await resolveRobotsTenant('gfi.iconn.app', 'other', fakeClient(tenants));
  assert.equal(t?.slug, 'gfi');
});

test('mismatched ?tenant= on {slug}.dev.iconn.app resolves the HOST tenant', async () => {
  const t = await resolveRobotsTenant('gfi.dev.iconn.app', 'other', fakeClient(tenants));
  assert.equal(t?.slug, 'gfi');
});

test('mismatched ?tenant= on a typo host never resolves the param tenant', async () => {
  const t = await resolveRobotsTenant('typo.iconn.app', 'gfi', fakeClient(tenants));
  assert.equal(t, null);
});

test('matching ?tenant= on {slug}.iconn.app still resolves', async () => {
  const t = await resolveRobotsTenant('gfi.iconn.app', 'gfi', fakeClient(tenants));
  assert.equal(t?.slug, 'gfi');
});

test('?tenant= on localhost keeps working (embeds/local testing)', async () => {
  const t = await resolveRobotsTenant('localhost:5000', 'other', fakeClient(tenants));
  assert.equal(t?.slug, 'other');
});

test('?tenant= on a custom domain keeps working', async () => {
  const t = await resolveRobotsTenant('somewhere.example.com', 'gfi', fakeClient(tenants));
  assert.equal(t?.slug, 'gfi');
});

test('no param: host resolution by slug and custom domain unchanged', async () => {
  assert.equal((await resolveRobotsTenant('gfi.iconn.app', undefined, fakeClient(tenants)))?.slug, 'gfi');
  assert.equal((await resolveRobotsTenant('gfi.dev.iconn.app', undefined, fakeClient(tenants)))?.slug, 'gfi');
  assert.equal((await resolveRobotsTenant('members.example.org', undefined, fakeClient(tenants)))?.slug, 'other');
});
