import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const handlers = {};
for (const name of ['complex-event', 'complex-events']) {
  const result = await build({
    entryPoints: [`api/public/${name}.js`], bundle: true, write: false, platform: 'node', format: 'esm',
    plugins: [{
      name: 'isolated-event-loading',
      setup(b) {
        b.onResolve({ filter: /^@supabase\/supabase-js$|\/(tenantResolver|privateTicketAccess)\.js$/ },
          args => ({ path: args.path, namespace: 'fixture' }));
        b.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({
          contents: path === '@supabase/supabase-js'
            ? 'export const createClient=()=>globalThis.eventLoadingFixture.db;'
            : path.endsWith('/tenantResolver.js')
              ? 'export const resolveTenantFromRequest=async()=>({id:"tenant"});'
              : 'export const loadPrivateTicketViewer=async()=>globalThis.eventLoadingFixture.viewer;',
        }));
      },
    }],
  });
  handlers[name] = (await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)).default;
}

const memberId = '11111111-1111-4111-8111-111111111111';
async function invoke(name, { ticketError = null, eventError = null, missing = false, waiting = true, viewer = null, query = { slug: 'meeting' } } = {}) {
  const calls = [];
  const event = { id: 'event', title: 'Meeting', waiting_list_enabled: waiting, status: 'published' };
  const tickets = [
    { id: 'ordinary', complex_event_id: 'event', price: 12, available_count: 2, visibility_mode: 'members_and_public' },
    { id: 'private', complex_event_id: 'event', price: 1, audience_mode: 'selected_members', selected_member_ids: [memberId], visibility_mode: 'members_only' },
  ];
  globalThis.eventLoadingFixture = { viewer, db: { from(table) {
    const call = { table, filters: [] }; calls.push(call);
    const builder = {
      select() { return this; }, order() { return this; }, or() { return this; },
      eq(...args) { call.filters.push(args); return this; },
      in(...args) { call.filters.push(args); return this; }, maybeSingle() { return this; },
      then(resolve) {
        return Promise.resolve(table === 'complex_event'
          ? { error: eventError, data: missing ? (name === 'complex-event' ? null : []) : name === 'complex-event' ? event : [event] }
          : table === 'complex_event_ticket_class' ? { error: ticketError, data: ticketError ? null : tickets }
            : { data: [], error: null, count: 2 }).then(resolve);
      },
    };
    return builder;
  } } };
  const res = { statusCode: 200, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await handlers[name]({ method: 'GET', query }, res);
  return { res, calls };
}

for (const name of Object.keys(handlers)) {
  test(`${name}: waiting event loads, tenant scoping and private audience remain enforced`, async () => {
    const { res, calls } = await invoke(name);
    assert.equal(res.statusCode, 200);
    const event = Array.isArray(res.body) ? res.body[0] : res.body;
    assert.equal(event.waiting_list_enabled, true);
    assert.deepEqual(event.pricing_config.ticket_classes.map(t => t.id), ['ordinary']);
    for (const table of ['complex_event', 'complex_event_ticket_class']) {
      assert.ok(calls.find(c => c.table === table).filters.some(([key, value]) => key === 'tenant_id' && value === 'tenant'));
    }
    assert.ok(!JSON.stringify(res.body).includes('selected_member_ids'));
  });
  test(`${name}: missing audience column and temporary ticket failure fail closed`, async () => {
    for (const code of ['42703', '57014']) {
      const { res } = await invoke(name, { ticketError: { code, message: 'fixture failure' } });
      assert.equal(res.statusCode, 503);
      assert.deepEqual(res.body, { error: 'Unable to load event tickets' });
    }
  });
  test(`${name}: cross-tenant viewer cannot see a known private ticket`, async () => {
    const { res } = await invoke(name, { viewer: { memberId, tenantId: 'other' } });
    assert.ok(!JSON.stringify(res.body).includes('"private"'));
  });
}

for (const query of [{ slug: 'meeting' }, { id: 'event' }]) {
  test(`detail ${Object.keys(query)[0]}: real absence is 404; database failure is 503`, async () => {
    assert.equal((await invoke('complex-event', { query, missing: true })).res.statusCode, 404);
    assert.equal((await invoke('complex-event', { query, eventError: { code: '57014', message: 'timeout' } })).res.statusCode, 503);
  });
}
test('ordinary booking retains price and sold-out capacity', async () => {
  const { res } = await invoke('complex-event', { waiting: false });
  assert.equal(res.body.waiting_list_enabled, false);
  assert.equal(res.body.pricing_config.ticket_classes[0].price, 12);
  assert.equal(res.body.pricing_config.ticket_classes[0].remaining, 0);
  assert.equal(res.body.pricing_config.ticket_classes[0].is_sold_out, true);
});
