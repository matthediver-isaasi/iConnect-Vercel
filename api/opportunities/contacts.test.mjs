import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpportunityContactsHandler } from './contacts.js';
import { loadOpportunityContacts } from '../../client/src/lib/opportunityContacts.js';

const org = '11111111-1111-4111-8111-111111111111';
function fixture({ organization = true, failure = false, allowed = true, authenticated = true } = {}) {
  const calls = [];
  const db = { from(table) {
    calls.push(['from', table]);
    const q = {
      select(...args) { calls.push(['select', ...args]); return q; },
      eq(...args) { calls.push(['eq', ...args]); return q; },
      or(...args) { calls.push(['or', ...args]); return q; },
      order(...args) { calls.push(['order', ...args]); return q; },
      async maybeSingle() { return { data: organization ? { id: org } : null }; },
      async range(start, end) {
        calls.push(['range', start, end]);
        return failure ? { error: new Error('Private database detail') }
          : { data: Array.from({ length: start === 0 ? 100 : 1 }, (_, i) => ({
            id: String(start + i), organization_id: org,
          })) };
      },
    };
    return q;
  } };
  const handler = createOpportunityContactsHandler({ db,
    getTenantContext: async () => ({ isAuthenticated: authenticated, tenantId: 'tenant',
      memberId: 'actor', roleId: 'sales-role' }),
    hasFeatureAccess: async () => allowed,
  });
  const run = async (query = { organizationId: org }, method = 'GET') => {
    const res = { statusCode: null, body: null, setHeader() {},
      status(code) { this.statusCode = code; return this; },
      json(value) { this.body = value; return this; } };
    await handler({ method, query }, res);
    return res;
  };
  return { calls, run };
}

test('Sales-authorised lookup lists organisation contacts without search text and paginates', async () => {
  const f = fixture();
  const first = await f.run();
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.items.length, 100);
  assert.equal(first.body.nextOffset, 100);
  const last = await f.run({ organizationId: org, offset: '100' });
  assert.equal(last.body.nextOffset, null);
  assert.equal(last.body.items.length, 1);
  assert.ok(f.calls.filter(c => c[0] === 'eq' && c[1] === 'tenant_id' && c[2] === 'tenant').length >= 4);
  assert.ok(f.calls.some(c => c[0] === 'eq' && c[1] === 'organization_id' && c[2] === org));
  assert.ok(f.calls.some(c => c[0] === 'or' && c[1] === 'email.is.null,email.not.ilike.deleted_%@deleted.local'));
});
test('lookup rejects unauthorized users, foreign/missing organisations and invalid requests', async () => {
  for (const [options, status] of [[{ allowed: false }, 403], [{ authenticated: false }, 401]]) {
    const f = fixture(options);
    assert.equal((await f.run()).statusCode, status);
    assert.equal(f.calls.length, 0);
  }
  const missing = fixture({ organization: false });
  assert.equal((await missing.run()).statusCode, 404);
  assert.ok(!missing.calls.some(c => c[0] === 'from' && c[1] === 'member'));
  const f = fixture();
  for (const query of [{}, { organizationId: 'bad' }, { organizationId: org, offset: '-1' }]) {
    assert.equal((await f.run(query)).statusCode, 400);
  }
  assert.equal((await f.run({}, 'POST')).statusCode, 405);
  assert.equal(f.calls.length, 0);
  assert.equal((await fixture({ failure: true }).run()).body.error, 'Could not load organisation contacts');
});
test('client loads all pages and passes cancellation without silently truncating', async () => {
  const f = fixture();
  const signal = new AbortController().signal;
  const members = await loadOpportunityContacts(org, { signal, fetchImpl: async (path, options) => {
    assert.equal(options.signal, signal);
    assert.equal(options.credentials, 'include');
    const res = await f.run(Object.fromEntries(new URL(path, 'http://local').searchParams));
    return { ok: res.statusCode === 200, json: async () => res.body };
  } });
  assert.equal(members.length, 101);
});
test('client distinguishes empty results from failures and rejects cross-organisation results', async () => {
  const fetchPayload = (payload, ok = true) => async () => ({ ok, json: async () => payload });
  assert.deepEqual(await loadOpportunityContacts(org, { fetchImpl: fetchPayload({ items: [], nextOffset: null }) }), []);
  await assert.rejects(loadOpportunityContacts(org, { fetchImpl: fetchPayload({ error: 'Denied' }, false) }), /Denied/);
  await assert.rejects(loadOpportunityContacts(org, { fetchImpl: fetchPayload({
    items: [{ id: 'm', organization_id: 'another-org' }], nextOffset: null,
  }) }), /Invalid organisation/);
  await assert.rejects(loadOpportunityContacts(org, { fetchImpl: fetchPayload({ items: [], nextOffset: 0 }) }), /pagination/);
});
