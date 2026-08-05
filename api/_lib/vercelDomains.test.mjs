import test from 'node:test';
import assert from 'node:assert/strict';
import {
  attachDomainToProject,
  detachDomainFromProject,
  findProjectHoldingDomain,
  reclaimDomainFromOtherProject,
  friendlyVercelError,
} from './vercelDomains.js';

const DOMAIN = 'bnms.org.uk';
const CURRENT = 'prj_current';
const OTHER = 'prj_other';

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

// Builds a fetch mock from an array of route handlers: { match: (url, opts) => bool, respond: (url, opts) => response }
function mockFetch(routes, calls = []) {
  return async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET' });
    for (const route of routes) {
      if (route.match(url, opts)) return route.respond(url, opts);
    }
    throw new Error(`Unexpected fetch: ${opts.method || 'GET'} ${url}`);
  };
}

function config(fetchImpl, overrides = {}) {
  return {
    token: 'tok',
    projectId: CURRENT,
    teamId: 'team_1',
    fetchImpl,
    log: () => {},
    logError: () => {},
    ...overrides,
  };
}

test('attachDomainToProject posts to the project domains endpoint with teamId', async () => {
  const calls = [];
  const fetchImpl = mockFetch([
    { match: (u, o) => o.method === 'POST' && u.includes(`/v10/projects/${CURRENT}/domains`), respond: () => jsonResponse(200, { name: DOMAIN }) },
  ], calls);
  const res = await attachDomainToProject(config(fetchImpl), DOMAIN);
  assert.equal(res.ok, true);
  assert.ok(calls[0].url.includes('teamId=team_1'));
});

test('detachDomainFromProject deletes from the given project only', async () => {
  const calls = [];
  const fetchImpl = mockFetch([
    { match: (u, o) => o.method === 'DELETE' && u.includes(`/v9/projects/${OTHER}/domains/${DOMAIN}`), respond: () => jsonResponse(200, {}) },
  ], calls);
  const res = await detachDomainFromProject(config(fetchImpl), DOMAIN, OTHER);
  assert.equal(res.ok, true);
  assert.equal(calls.length, 1);
});

test('findProjectHoldingDomain traverses pagination to find owner on a later page', async () => {
  const fetchImpl = mockFetch([
    {
      match: (u) => u.includes('/v9/projects?limit=100') && !u.includes('until='),
      respond: () => jsonResponse(200, { projects: [{ id: CURRENT, name: 'current' }, { id: 'prj_a', name: 'a' }], pagination: { next: 111 } }),
    },
    {
      match: (u) => u.includes('until=111'),
      respond: () => jsonResponse(200, { projects: [{ id: OTHER, name: 'other' }], pagination: { next: null } }),
    },
    { match: (u) => u.includes(`/v9/projects/prj_a/domains/${DOMAIN}`), respond: () => jsonResponse(404, { error: { code: 'not_found' } }) },
    { match: (u) => u.includes(`/v9/projects/${OTHER}/domains/${DOMAIN}`), respond: () => jsonResponse(200, { name: DOMAIN }) },
  ]);
  const { project } = await findProjectHoldingDomain(config(fetchImpl), DOMAIN);
  assert.equal(project.id, OTHER);
});

test('findProjectHoldingDomain returns null owner when no project holds the domain', async () => {
  const fetchImpl = mockFetch([
    { match: (u) => u.includes('/v9/projects?limit=100'), respond: () => jsonResponse(200, { projects: [{ id: 'prj_a', name: 'a' }], pagination: { next: null } }) },
    { match: (u) => u.includes(`/v9/projects/prj_a/domains/${DOMAIN}`), respond: () => jsonResponse(404, {}) },
  ]);
  const { project } = await findProjectHoldingDomain(config(fetchImpl), DOMAIN);
  assert.equal(project, null);
});

test('reclaim succeeds: detach from owner then attach to current project', async () => {
  const calls = [];
  const fetchImpl = mockFetch([
    { match: (u) => u.includes('/v9/projects?limit=100'), respond: () => jsonResponse(200, { projects: [{ id: OTHER, name: 'other' }], pagination: { next: null } }) },
    { match: (u, o) => (o.method || 'GET') === 'GET' && u.includes(`/v9/projects/${OTHER}/domains/${DOMAIN}`), respond: () => jsonResponse(200, { name: DOMAIN }) },
    { match: (u, o) => o.method === 'DELETE' && u.includes(`/v9/projects/${OTHER}/domains/${DOMAIN}`), respond: () => jsonResponse(200, {}) },
    { match: (u, o) => o.method === 'POST' && u.includes(`/v10/projects/${CURRENT}/domains`), respond: () => jsonResponse(200, { name: DOMAIN }) },
  ], calls);
  const result = await reclaimDomainFromOtherProject(config(fetchImpl), DOMAIN);
  assert.equal(result.reclaimed, true);
  const detachCalls = calls.filter((c) => c.method === 'DELETE');
  assert.equal(detachCalls.length, 1);
  assert.ok(detachCalls[0].url.includes(OTHER));
});

test('reclaim rolls back to the original project when re-attach fails', async () => {
  const calls = [];
  const fetchImpl = mockFetch([
    { match: (u) => u.includes('/v9/projects?limit=100'), respond: () => jsonResponse(200, { projects: [{ id: OTHER, name: 'other' }], pagination: { next: null } }) },
    { match: (u, o) => (o.method || 'GET') === 'GET' && u.includes(`/v9/projects/${OTHER}/domains/${DOMAIN}`), respond: () => jsonResponse(200, { name: DOMAIN }) },
    { match: (u, o) => o.method === 'DELETE' && u.includes(`/v9/projects/${OTHER}/domains/${DOMAIN}`), respond: () => jsonResponse(200, {}) },
    { match: (u, o) => o.method === 'POST' && u.includes(`/v10/projects/${CURRENT}/domains`), respond: () => jsonResponse(500, { error: { code: 'internal_error' } }) },
    { match: (u, o) => o.method === 'POST' && u.includes(`/v10/projects/${OTHER}/domains`), respond: () => jsonResponse(200, { name: DOMAIN }) },
  ], calls);
  const result = await reclaimDomainFromOtherProject(config(fetchImpl), DOMAIN);
  assert.equal(result.reclaimed, false);
  assert.equal(result.reason, 'reattach_failed');
  // Rollback attach to the original project must have happened
  const rollback = calls.find((c) => c.method === 'POST' && c.url.includes(`/v10/projects/${OTHER}/domains`));
  assert.ok(rollback, 'expected rollback attach to original project');
});

test('reclaim logs escalation when rollback itself fails', async () => {
  const errors = [];
  const fetchImpl = mockFetch([
    { match: (u) => u.includes('/v9/projects?limit=100'), respond: () => jsonResponse(200, { projects: [{ id: OTHER, name: 'other' }], pagination: { next: null } }) },
    { match: (u, o) => (o.method || 'GET') === 'GET' && u.includes(`/v9/projects/${OTHER}/domains/${DOMAIN}`), respond: () => jsonResponse(200, { name: DOMAIN }) },
    { match: (u, o) => o.method === 'DELETE' && u.includes(`/v9/projects/${OTHER}/domains/${DOMAIN}`), respond: () => jsonResponse(200, {}) },
    { match: (u, o) => o.method === 'POST' && u.includes('/v10/projects/'), respond: () => jsonResponse(500, { error: { code: 'internal_error' } }) },
  ]);
  const result = await reclaimDomainFromOtherProject(config(fetchImpl, { logError: (...args) => errors.push(args.join(' ')) }), DOMAIN);
  assert.equal(result.reclaimed, false);
  assert.ok(errors.some((e) => e.includes('ROLLBACK FAILED')), 'expected explicit rollback-failure escalation log');
});

test('reclaim does not detach when detach is rejected, and reports detach_failed', async () => {
  const calls = [];
  const fetchImpl = mockFetch([
    { match: (u) => u.includes('/v9/projects?limit=100'), respond: () => jsonResponse(200, { projects: [{ id: OTHER, name: 'other' }], pagination: { next: null } }) },
    { match: (u, o) => (o.method || 'GET') === 'GET' && u.includes(`/v9/projects/${OTHER}/domains/${DOMAIN}`), respond: () => jsonResponse(200, { name: DOMAIN }) },
    { match: (u, o) => o.method === 'DELETE', respond: () => jsonResponse(403, { error: { code: 'forbidden' } }) },
  ], calls);
  const result = await reclaimDomainFromOtherProject(config(fetchImpl), DOMAIN);
  assert.equal(result.reclaimed, false);
  assert.equal(result.reason, 'detach_failed');
  // No attach attempts should have been made after the failed detach
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
});

test('reclaim tolerates domain_already_exists on re-attach (already on current project)', async () => {
  const fetchImpl = mockFetch([
    { match: (u) => u.includes('/v9/projects?limit=100'), respond: () => jsonResponse(200, { projects: [{ id: OTHER, name: 'other' }], pagination: { next: null } }) },
    { match: (u, o) => (o.method || 'GET') === 'GET' && u.includes(`/v9/projects/${OTHER}/domains/${DOMAIN}`), respond: () => jsonResponse(200, { name: DOMAIN }) },
    { match: (u, o) => o.method === 'DELETE', respond: () => jsonResponse(200, {}) },
    { match: (u, o) => o.method === 'POST', respond: () => jsonResponse(409, { error: { code: 'domain_already_exists' } }) },
  ]);
  const result = await reclaimDomainFromOtherProject(config(fetchImpl), DOMAIN);
  assert.equal(result.reclaimed, true);
});

test('friendlyVercelError maps known codes to actionable messages, never raw Vercel text', () => {
  const inUse = friendlyVercelError({ code: 'domain_already_in_use', message: "Cannot add bnms.org.uk since it's already in use by one of your projects." });
  assert.ok(!inUse.includes('Cannot add'), 'must not pass raw Vercel wording through');
  assert.ok(inUse.toLowerCase().includes('another site'));

  const failedReclaim = friendlyVercelError({ code: 'domain_already_in_use' }, 'detach_failed');
  assert.ok(failedReclaim.includes('could not be transferred'));

  assert.ok(friendlyVercelError({ code: 'domain_taken' }).includes('different account'));
  assert.ok(friendlyVercelError({ code: 'verification_required' }).includes('verification'));
  assert.ok(friendlyVercelError({ code: 'invalid_domain' }).includes('valid domain'));
  assert.ok(friendlyVercelError({ code: 'something_new' }).length > 0);
  assert.ok(friendlyVercelError(undefined).length > 0);
});
