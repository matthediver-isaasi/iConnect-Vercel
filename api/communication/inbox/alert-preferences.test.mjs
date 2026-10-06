import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const source = (await readFile(new URL('./alert-preferences.js', import.meta.url), 'utf8'))
  .replace("import { supabase } from '../../_lib/database.js';", 'const supabase = globalThis.__alertTest.db;')
  .replace("import { getSession } from '../../_lib/session.js';", 'const getSession = async () => globalThis.__alertTest.session;')
  .replace("import { getTenantContext } from '../../_lib/tenantContext.js';", 'const getTenantContext = async () => globalThis.__alertTest.context;');
const state = {
  context: { isAuthenticated: true, memberId: 'member', tenantId: 'tenant' },
  session: { id: 'server-only-login-secret', data: { memberId: 'member', tenantId: 'tenant' } },
  writes: [], reads: [], fail: false,
};
state.db = {
  rpc: async (name, params) => { state.writes.push({ name, params }); return { error: state.fail ? new Error('offline') : null }; },
  from: table => ({
    select: () => ({
      match: scope => ({
        maybeSingle: async () => {
          state.reads.push({ table, scope });
          return { data: null, error: state.fail ? new Error('offline') : null };
        },
      }),
    }),
  }),
};
globalThis.__alertTest = state;
const { default: handler } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const key = createHash('sha256').update(`inbox-alert:${state.session.id}`).digest('hex');
const body = { member_id: 'member', tenant_id: 'tenant', login_key: key, preference: { always_hide: true } };
async function call(method, payload) {
  const res = { code: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.code = code; return this; }, json(data) { this.body = data; return this; } };
  await handler({ method, body: payload }, res);
  return res;
}
test('self-service API scopes reads and writes, fences stale browsers, and never returns credentials', async () => {
  const read = await call('GET');
  assert.equal(read.code, 200);
  assert.equal(read.headers['Cache-Control'], 'private, no-store');
  assert.equal(read.body.always_hide, false);
  assert.equal(JSON.stringify(read.body).includes(state.session.id), false);
  assert.deepEqual(state.reads[0].scope, { tenant_id: 'tenant', member_id: 'member' });
  assert.equal((await call('PATCH', body)).code, 200);
  assert.equal(state.writes.length, 1);
  assert.deepEqual(state.writes[0].params, {
    p_sid: state.session.id, p_tenant: 'tenant', p_member: 'member', p_field: 'always_hide', p_value: true,
  });
  for (const patch of [
    { ...body, member_id: 'foreign' }, { ...body, tenant_id: 'foreign' }, { ...body, login_key: 'older-login' },
  ]) assert.equal((await call('PATCH', patch)).code, 409);
  for (const preference of [{ is_read: true }, { shown: false }, { always_hide: 'true' }, { always_hide: true, hide_until_login: true }]) {
    assert.equal((await call('PATCH', { ...body, preference })).code, 400);
  }
  assert.equal(state.writes.length, 1);
  state.fail = true;
  assert.equal((await call('GET')).code, 503);
  assert.equal((await call('PATCH', body)).code, 503);
  state.fail = false;
  state.context.isAuthenticated = false;
  assert.equal((await call('GET')).code, 401);
  assert.equal((await call('PATCH', body)).code, 401);
  state.context.isAuthenticated = true;
  state.session.data.memberId = 'foreign';
  assert.equal((await call('GET')).code, 401);
});
