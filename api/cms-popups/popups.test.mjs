import test from 'node:test';
import assert from 'node:assert/strict';
import { createPopupDeliveryHandler } from './index.js';
import { createPopupAdminHandler } from '../admin/cms-popups/index.js';
import { POPUP_DEFAULT_CONFIG, POPUP_EMPTY_DESIGN } from '../../shared/cmsPopupContract.js';
const tid = '00000000-0000-0000-0000-000000000001';
const pid = '00000000-0000-0000-0000-000000000002';
const popupId = '00000000-0000-0000-0000-000000000003';
const popup = () => ({ id: popupId, tenant_id: tid, status: 'active', revision: 1, dismissal_generation: 1,
  config: { ...structuredClone(POPUP_DEFAULT_CONFIG), all_pages: true }, design: POPUP_EMPTY_DESIGN });
function database(overrides = {}) {
  const reads = [];
  const rows = { i_edit_page: { id: pid, tenant_id: tid, status: 'published', layout_type: 'public', microsite_id: null },
    cms_popup: [popup()], preference_field: [], ...overrides };
  return { reads, from(table) {
    const call = { table, filters: [] }; reads.push(call);
    const q = {};
    for (const op of ['select', 'eq', 'in', 'is', 'or', 'order', 'range', 'maybeSingle', 'single']) q[op] = (...args) => { call.filters.push([op, ...args]); return q; };
    q.then = (yes, no) => Promise.resolve(rows[table] instanceof Error ? { error: rows[table] }
      : { data: rows[table], count: Array.isArray(rows[table]) ? rows[table].length : null }).then(yes, no);
    return q;
  } };
}
function response() {
  return { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, getHeader(k) { return this.headers[k]; },
    status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}
const tenant = { id: tid, status: 'active', settings: { timezone: 'UTC' } };
const guest = { isAuthenticated: false };
async function deliver({ db = database(), context = guest, input = { page_id: pid }, method = 'GET' } = {}) {
  const res = response();
  await createPopupDeliveryHandler({ db, resolveTenant: async () => tenant, contextFor: async () => context })
    ({ method, query: input, body: input }, res);
  return { res, db };
}
test('batch payload never releases design, targeting rules or member fields', async () => {
  const { res, db } = await deliver();
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.candidates.length, 1);
  assert.equal(res.body.candidates[0].design, undefined);
  assert.equal(res.body.candidates[0].config.groups, undefined);
  assert.match(res.headers['Cache-Control'], /no-store/);
  assert.equal(db.reads.some(r => r.table === 'member'), false);
  for (const read of db.reads) assert.ok(read.filters.some(f => f[0] === 'eq' && f[1] === 'tenant_id' && f[2] === tid));
});
test('selected popup read requires fresh revision and independently authorizes page', async () => {
  const { res } = await deliver({ input: { page_id: pid, id: popupId, revision: 1 } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.popup.design, POPUP_EMPTY_DESIGN);
  const stale = await deliver({ input: { page_id: pid, id: popupId, revision: 0 } });
  assert.equal(stale.res.statusCode, 409);
  const removed = await deliver({ db: database({ i_edit_page: null }), input: { page_id: pid, id: popupId, revision: 1 } });
  assert.equal(removed.res.statusCode, 404);
});
test('member page and microsite mismatch fail before popup queries', async () => {
  for (const page of [
    { id: pid, layout_type: 'member' },
    { id: pid, layout_type: 'public', microsite_id: popupId },
  ]) {
    const { res, db } = await deliver({ db: database({ i_edit_page: page }) });
    assert.equal(res.statusCode, 404);
    assert.equal(db.reads.some(r => r.table === 'cms_popup'), false);
  }
});
test('cross-tenant identity never downgrades to a guest', async () => {
  const { res, db } = await deliver({ context: { isAuthenticated: true, tenantId: popupId, memberId: pid } });
  assert.equal(res.statusCode, 403);
  assert.equal(db.reads.length, 0);
});
test('invalid targeting and failed metadata do not broaden eligibility', async () => {
  const invalid = popup();
  invalid.config.groups = [{ conditions: [{ field_key: 'secret', field_type: 'custom', entity_scope: 'member', data_type: 'text', operator: 'is_empty' }] }];
  for (const overrides of [{ cms_popup: [invalid] }, { preference_field: new Error('offline') }]) {
    const { res } = await deliver({ db: database(overrides) });
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.popup, undefined);
  }
});
test('page-editor permission alone cannot read or preview popup designs', async () => {
  for (const query of [{ id: popupId }, { id: popupId, preview: '1' }]) {
    const db = database(); const res = response();
    await createPopupAdminHandler({ db, contextFor: async () => ({ isAuthenticated: true, tenantId: tid, roleId: pid }),
      featureAccess: async (_, feature) => feature === 'site-builder.page-editor' })({ method: 'GET', query }, res);
    assert.equal(res.statusCode, 403);
    assert.equal(db.reads.length, 0);
  }
});
test('anonymous visitor cannot mutate member preferences', async () => {
  const { res } = await deliver({ method: 'POST', input: { page_id: pid, id: popupId, revision: 1, generation: 1, action: 'permanent' } });
  assert.equal(res.statusCode, 401);
});
