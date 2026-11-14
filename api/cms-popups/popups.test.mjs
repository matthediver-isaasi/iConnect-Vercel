import test from 'node:test';
import assert from 'node:assert/strict';
import { createPopupDeliveryHandler } from './index.js';
import { createPopupAdminHandler } from '../admin/cms-popups/index.js';
import { POPUP_DEFAULT_CONFIG, POPUP_EMPTY_DESIGN } from '../../shared/cmsPopupContract.js';
import { validatePopupDocument } from '../_lib/cmsPopupService.js';
import { popupPortalAccess } from '../_lib/popupPortalAccess.js';
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
test('Forum delivery uses actual forum access in every phase, without a permission stub', async () => {
  const phases = [{}, { id: popupId, revision: 1 }, { revalidate: '1' },
    { id: popupId, revision: 1, revalidate: '1' },
    { id: popupId, revision: 1, generation: 1, action: 'shown' },
    { id: popupId, revision: 1, generation: 1, action: 'permanent' }];
  for (const phase of phases) {
    for (const excluded of [false, true]) {
      const notice = popup();
      notice.config = { ...notice.config, all_pages: false, portal_pages: ['Forum'] };
      const db = database({ cms_popup: [notice], role: { id: popupId, excluded_features: excluded ? ['forum'] : [] },
        role_access_item: [], system_settings: null, cms_popup_member_state: [] });
      let writes = 0;
      db.rpc = () => { writes++; return Promise.resolve({ data: true }); };
      const input = { portal_page: 'Forum', ...phase };
      const res = response();
      await createPopupDeliveryHandler({ db, resolveTenant: async () => tenant,
        contextFor: async () => ({ isAuthenticated: true, tenantId: tid, memberId: pid,
          roleId: popupId, memberExcludedFeatures: [] }) })({
            method: phase.action ? 'POST' : 'GET', query: input, body: input,
          }, res);
      assert.equal(res.statusCode, excluded ? 403 : 200, JSON.stringify({ phase, excluded }));
      assert.equal(writes, !excluded && !!phase.action ? 1 : 0);
      if (excluded) {
        assert.equal(res.body.popup, undefined);
        assert.equal(res.body.candidates, undefined);
        assert.equal(db.reads.some(read => read.table === 'cms_popup'), false);
      }
    }
  }
});
test('portal page access requires fresh role and complete hierarchy evidence', async () => {
  const context = { tenantId: tid, roleId: pid, memberExcludedFeatures: [] };
  const role = { id: pid, excluded_features: [] };
  assert.equal(await popupPortalAccess(database({ role, role_access_item: [] }), context, 'page_user_History'), true);
  for (const override of [{ role: null }, { role: new Error('offline') }, { role_access_item: new Error('offline') }]) {
    await assert.rejects(popupPortalAccess(database({ role, role_access_item: [], ...override }), context, 'page_user_History'));
  }
  const hierarchy = [{ id: 'module', item_key: 'custom-module', item_type: 'module', is_active: true },
    { id: 'page', item_key: 'commerce.history', item_type: 'page', parent_id: 'module', is_active: true }];
  assert.equal(await popupPortalAccess(database({ role: { ...role, excluded_features: ['custom-module'] }, role_access_item: hierarchy }), context, 'page_user_History'), false);
});
test('portal phases require explicit assignments and fresh member page access', async () => {
  const member = { isAuthenticated: true, tenantId: tid, memberId: pid, roleId: popupId };
  for (const phase of [{}, { id: popupId, revision: 1 }, { id: popupId, revision: 1, revalidate: '1' },
    { id: popupId, revision: 1, generation: 1, action: 'permanent' }]) {
    for (const scenario of ['allowed', 'removed', 'denied', 'guest', 'cross-tenant', 'preferences-failed', 'visibility-failed']) {
      const p = popup();
      p.config.portal_pages = scenario === 'removed' ? [] : ['Events'];
      const db = database({ cms_popup: [p], cms_popup_member_state: scenario === 'preferences-failed' ? new Error('offline') : [],
        system_settings: scenario === 'visibility-failed' ? new Error('offline') : null });
      let writes = 0;
      db.rpc = () => { writes++; return Promise.resolve({ data: true }); };
      const res = response();
      await createPopupDeliveryHandler({ db, resolveTenant: async () => tenant,
        contextFor: async () => scenario === 'guest' ? guest : scenario === 'cross-tenant' ? { ...member, tenantId: pid } : member,
        featureAccess: async () => scenario !== 'denied' })({
          method: phase.action ? 'POST' : 'GET', query: { portal_page: 'Events', ...phase }, body: { portal_page: 'Events', ...phase },
        }, res);
      const expected = scenario === 'allowed' ? 200 : scenario === 'removed' ? (phase.id ? 404 : 200)
        : scenario.endsWith('failed') ? 503 : 403;
      assert.equal(res.statusCode, expected, `${scenario}: ${JSON.stringify(phase)}`);
      if (scenario === 'removed' && !phase.id) assert.deepEqual(res.body.candidates, []);
      if (scenario === 'allowed' && !phase.id) assert.equal(res.body.candidates[0].config.portal_pages, undefined);
      assert.equal(writes, scenario === 'allowed' && !!phase.action ? 1 : 0);
      assert.equal(db.reads.some(r => r.table === 'i_edit_page'), false);
    }
  }
});
test('portal modes reject ambiguous, microsite and unknown targets', async () => {
  for (const input of [{ portal_page: 'AdminSetup' }, { portal_page: 'Events', page_id: pid },
    { portal_page: 'Events', page_slug: 'home' }, { portal_page: 'Events', microsite_id: pid }]) {
    assert.equal((await deliver({ input })).res.statusCode, 400);
  }
});
test('portal-only activation and mixed assignments preserve CMS page validation', async () => {
  const p = { ...popup(), name: 'Portal notice', config: { ...popup().config, all_pages: false, portal_pages: ['Events'] } };
  const fields = { member: { core: [], custom: [] }, organization: { core: [], custom: [] } };
  await validatePopupDocument(database(), tid, p, fields);
  await assert.rejects(validatePopupDocument(database(), tid, { ...p, microsite_id: pid }, fields), /main-site/);
  await assert.rejects(validatePopupDocument(database(), tid, { ...p, config: { ...p.config, portal_pages: [] } }, fields), /Assign/);
  await validatePopupDocument(database({ i_edit_page: [{ id: pid, microsite_id: null }] }), tid,
    { ...p, config: { ...p.config, page_ids: [pid] } }, fields);
});
test('popup requests reuse session only within each fresh authorization pass', async () => {
  let calls = 0;
  const handler = createPopupDeliveryHandler({ db: database(), resolveTenant: async () => tenant,
    contextFor: async (_req, options) => {
      assert.deepEqual(options, { reuseSessionWithinPass: true });
      calls++;
      return calls <= 2 ? guest : { isAuthenticated: true, tenantMismatch: true };
    } });
  for (const input of [{ page_id: pid }, { page_id: pid, id: popupId, revision: 1 }]) {
    const res = response();
    await handler({ method: 'GET', query: input }, res);
    assert.equal(res.statusCode, 200);
  }
  const res = response();
  await handler({ method: 'POST', body: { page_id: pid, id: popupId, revision: 1, generation: 1, action: 'shown' } }, res);
  assert.equal(calls, 3);
  assert.equal(res.statusCode, 403, 'later authorization change must not reuse earlier identity');
});
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
  for (const stage of ['resolve_tenant', 'resolve_viewer', 'page', 'candidates', 'fields', 'audience', 'preferences', 'total']) {
    assert.match(res.headers['Server-Timing'], new RegExp(`${stage};dur=\\d`));
  }
  assert.equal(res.headers['Server-Timing'].includes(tid), false);
  assert.equal(db.reads.some(r => r.table === 'member'), false);
  for (const read of db.reads) assert.ok(read.filters.some(f => f[0] === 'eq' && f[1] === 'tenant_id' && f[2] === tid));
});
test('slug discovery is scoped, metadata-only, and returns the resolved page ID', async () => {
  const { res, db } = await deliver({ input: { page_slug: 'homely' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.page_id, pid);
  assert.equal(res.body.candidates[0].design, undefined);
  const read = db.reads.find(r => r.table === 'i_edit_page');
  for (const filter of [['eq', 'slug', 'homely'], ['eq', 'tenant_id', tid], ['eq', 'status', 'published'], ['is', 'microsite_id', null]]) {
    assert.ok(read.filters.some(f => JSON.stringify(f) === JSON.stringify(filter)));
  }
  const unavailable = await deliver({ db: database({ i_edit_page: null }), input: { page_slug: 'missing' } });
  assert.equal(unavailable.res.statusCode, 404);
});
test('slugs cannot replace page IDs for content or writes or bypass identity/page gates', async () => {
  for (const input of [{ page_slug: 'homely', id: popupId, revision: 1 }, { page_slug: '../homely' }, { page_slug: 'homely', page_id: 'invalid' }]) {
    assert.equal((await deliver({ input })).res.statusCode, 400);
  }
  assert.equal((await deliver({ input: { page_slug: 'homely' }, method: 'POST' })).res.statusCode, 400);
  assert.equal((await deliver({ input: { page_slug: 'homely' }, context: { isAuthenticated: true, tenantId: popupId } })).res.statusCode, 403);
  assert.equal((await deliver({ input: { page_slug: 'homely' }, db: database({ i_edit_page: { id: pid, layout_type: 'member' } }) })).res.statusCode, 404);
});
test('member preference and audience reads run concurrently without broadening eligibility', { timeout: 2000 }, async () => {
  const targeted = popup();
  targeted.config.groups = [{ conditions: [{ field_key: 'role_id', field_type: 'core', entity_scope: 'member', data_type: 'text', operator: 'equals', value: popupId }] }];
  const db = database({ cms_popup: [targeted], member: { id: pid, role_id: popupId }, cms_popup_member_state: [] });
  const original = db.from;
  let releaseMember;
  const gate = new Promise(resolve => { releaseMember = resolve; });
  db.from = table => {
    const q = original(table);
    const then = q.then;
    q.then = (yes, no) => {
      if (table === 'member') return gate.then(() => then(yes, no));
      if (table === 'cms_popup_member_state') releaseMember();
      return then(yes, no);
    };
    return q;
  };
  const { res } = await deliver({ db, context: { isAuthenticated: true, tenantId: tid, memberId: pid } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.candidates.length, 1);
});
test('selected popup read requires fresh revision and independently authorizes page', async () => {
  const { res } = await deliver({ input: { page_id: pid, id: popupId, revision: 1 } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.popup.design, POPUP_EMPTY_DESIGN);
  const stale = await deliver({ input: { page_id: pid, id: popupId, revision: 0 } });
  assert.equal(stale.res.statusCode, 409);
  assert.match(stale.res.headers['Server-Timing'], /total;dur=\d/);
  assert.match(res.headers['Server-Timing'], /design;dur=\d/);
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
