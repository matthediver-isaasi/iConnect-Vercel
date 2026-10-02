import test from 'node:test';
import assert from 'node:assert/strict';
import { accountingRequestCronHandler } from '../cron/reconcile-accounting-requests.js';
import { accountingRequestHealthHandler } from '../health/accounting-requests.js';

function response() {
  return { headers: {}, setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
}
const request = (method = 'GET', token = 'secret') => ({ method, headers: { authorization: `Bearer ${token}` } });
test('cron auth and explicit off gate prevent ALL reconciliation/database access', async () => {
  let calls = 0;
  const handler = accountingRequestCronHandler({ secret: 'secret', enabled: () => false,
    db: { rpc() { throw new Error('must not query'); } }, reconcile: async () => { calls++; throw new Error('must not run'); } });
  for (const [req, code] of [[request('DELETE'), 405], [request('GET', 'wrong'), 401], [request(), 200]]) {
    const res = response();
    await handler(req, res);
    assert.equal(res.code, code);
    if (code === 200) assert.deepEqual(res.body, { ok: true, enabled: false, processed: 0 });
  }
  assert.equal(calls, 0);
  const res = response();
  await accountingRequestCronHandler({ secret: '', enabled: () => true })(request('GET', ''), res);
  assert.equal(res.code, 401, 'missing secret must never authorize');
});
test('enabled cron processes bounded worker and reports persistence errors', async () => {
  let calls = 0;
  for (const fail of [false, true]) {
    const res = response();
    await accountingRequestCronHandler({ secret: 'secret', enabled: () => true,
      reconcile: async () => { calls++; if (fail) throw new Error('private'); return [{ id: 'one' }]; } })(request(), res);
    assert.equal(res.code, fail ? 503 : 200);
    assert.equal(JSON.stringify(res.body).includes('private'), false);
  }
  assert.equal(calls, 2);
});
test('health is authenticated, aggregate-only, read-only and fail closed', async () => {
  let calls = 0;
  const data = { status: 'healthy', total: 0, pending: 0, retry: 0, running: 0, unknown: 0, review: 0,
    complete: 0, overdue: 0, expired_leases: 0, waiting_provider: 0, secretField: 'not exposed' };
  const handler = accountingRequestHealthHandler({ secret: 'secret', enabled: () => false,
    db: { rpc: async name => { calls++; assert.equal(name, 'accounting_request_health'); return { data }; } } });
  const denied = response();
  await handler(request('GET', 'bad'), denied);
  assert.equal(denied.code, 401);
  assert.equal(calls, 0);
  const res = response();
  await handler(request(), res);
  assert.equal(res.code, 200);
  assert.equal(res.body.enabled, false);
  assert.equal(JSON.stringify(res.body).includes('not exposed'), false);
  const unavailable = response();
  await accountingRequestHealthHandler({ secret: 'secret', db: { rpc: async () => ({ error: { code: 'PGRST202' } }) } })(request(), unavailable);
  assert.equal(unavailable.code, 503);
});