import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeoHandler } from './seo.js';

const pageId = '823c98c6-2bfe-443b-b459-49924c33f69a';
function setup(overrides = {}) {
  const calls = [];
  const query = {
    select: () => query,
    eq: (key, value) => { calls.push([key, value]); return query; },
    maybeSingle: async () => ({ data: { id: pageId, title: 'Page', canvas_design: { content: { text: 'Page content' } } } }),
  };
  const deps = {
    db: { from: () => query },
    getTenantContext: async () => ({ isAuthenticated: true, tenantId: 'tenant-a', memberId: 'member-a' }),
    canUseAiFeature: async () => true,
    loadStudioSettings: async () => ({ enabled: true }),
    checkAiUsageAllowance: async () => ({ ok: true }),
    recordAiUsageEvent: async () => { calls.push('metered'); },
    getClient: () => ({}),
    generate: async (_client, source) => { calls.push(source); return { meta_title: 'Suggested' }; },
    ...overrides,
  };
  const res = { setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  return { calls, res, handler: createSeoHandler(deps) };
}
test('requires authentication and AI editor permission before looking up page', async () => {
  for (const overrides of [
    { getTenantContext: async () => null },
    { canUseAiFeature: async () => false },
  ]) {
    const { handler, res, calls } = setup(overrides);
    await handler({ method: 'POST', body: { pageId } }, res);
    assert.ok([401, 404].includes(res.code));
    assert.deepEqual(calls, []);
  }
});
test('scopes page lookup to tenant, uses unsaved copy, meters generation without page writes', async () => {
  const { handler, res, calls } = setup();
  await handler({ method: 'POST', body: { pageId, design: { content: { html: '<p>Unsaved copy</p>' } } } }, res);
  assert.equal(res.code, 200);
  assert.ok(calls.some(c => c[0] === 'tenant_id' && c[1] === 'tenant-a'));
  assert.ok(calls.some(c => c.copy === 'Unsaved copy'));
  assert.ok(calls.includes('metered'));
});
test('rejects inaccessible pages, disabled AI, quota failures and provider failure', async () => {
  for (const [override, status] of [
    [{ db: { from: () => ({ select() { return this; }, eq() { return this; }, maybeSingle: async () => ({ data: null }) }) } }, 404],
    [{ loadStudioSettings: async () => ({ allowAiCopy: false }) }, 403],
    [{ checkAiUsageAllowance: async () => ({ ok: false, status: 429, body: { error: 'Limit reached' } }) }, 429],
    [{ generate: async () => { throw new Error('private provider details'); } }, 502],
    [{ getClient: () => null }, 503],
  ]) {
    const { handler, res } = setup(override);
    await handler({ method: 'POST', body: { pageId } }, res);
    assert.equal(res.code, status);
    assert.doesNotMatch(JSON.stringify(res.body), /private provider details/);
  }
});
