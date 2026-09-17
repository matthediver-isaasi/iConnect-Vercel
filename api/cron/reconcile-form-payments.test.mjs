import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createFormPaymentReconciliationHandler,
  formPaymentReconciliationResponse,
} from './reconcile-form-payments.js';

function response() {
  return {
    statusCode: 200,
    headers: {},
    setHeader(key, value) { this.headers[key] = value; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
  };
}

test('response distinguishes successful invocation, partial work, and hidden sweep failures', () => {
  const clean = { finalized: 1, errors: [] };
  assert.deepEqual(formPaymentReconciliationResponse(clean, 100), {
    finalized: 1, errors: [], ok: true, partial: false, durationMs: 100,
  });
  const waiting = { errors: [], completion: { waitingForAddress: 2 } };
  assert.equal(formPaymentReconciliationResponse(waiting, 100).partial, true);
  const failed = { errors: [], issues: [{ scope: 'stripe-address-mapping-retry', code: 'RECOVERY_FAILED' }] };
  Object.defineProperty(failed, '__heartbeatFailures', {
    value: [{ scope: 'stripe-address-mapping-retry', error: 'private internal failure' }],
    enumerable: false,
  });
  const out = formPaymentReconciliationResponse(failed, 100);
  assert.equal(out.ok, false);
  assert.equal(out.partial, true);
  assert.ok(!JSON.stringify(out).includes('private internal failure'));
  assert.equal(formPaymentReconciliationResponse({ errors: [], budgetExhausted: true }, 100).partial, true);
});

test('handler authenticates before work and returns actual reconciliation health', async () => {
  const originalSecret = process.env.CRON_SECRET;
  const calls = [];
  const heartbeat = [];
  const db = {};
  const handler = createFormPaymentReconciliationHandler({
    db,
    reconcile: async (database, options) => {
      calls.push({ database, options });
      return { checked: 9, finalized: 0, errors: [], partial: true,
        completion: { waitingForAddress: 3 }, addressRecovery: { attempted: 4, succeeded: 3, failed: 1 } };
    },
    createReporter: () => async (healthy) => { heartbeat.push(healthy); },
  });
  try {
    delete process.env.CRON_SECRET;
    let res = response();
    await handler({ method: 'GET', headers: {} }, res);
    assert.equal(res.statusCode, 503);
    assert.equal(calls.length, 0);
    assert.equal(heartbeat.length, 0);

    process.env.CRON_SECRET = 'fixture-cron-secret';
    res = response();
    await handler({ method: 'GET', headers: { authorization: 'Bearer wrong' } }, res);
    assert.equal(res.statusCode, 401);
    assert.equal(calls.length, 0);

    res = response();
    await handler({ method: 'DELETE', headers: { authorization: 'Bearer fixture-cron-secret' } }, res);
    assert.equal(res.statusCode, 405);
    assert.equal(calls.length, 0);

    res = response();
    await handler({ method: 'GET', headers: { authorization: 'Bearer fixture-cron-secret' } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.partial, true);
    assert.deepEqual(res.body.addressRecovery, { attempted: 4, succeeded: 3, failed: 1 });
    assert.deepEqual(calls[0], { database: db, options: { limit: 20, timeBudgetMs: 40_000 } });
  } finally {
    if (originalSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalSecret;
  }
});

test('targeted route requires exactly one UUID and cannot fall back to the global worker', async () => {
  const originalSecret = process.env.CRON_SECRET;
  const id = 'd67f867e-0f99-4320-ae9f-c58f2788a847';
  const calls = [];
  const handler = createFormPaymentReconciliationHandler({
    db: {},
    targetedOnly: true,
    reconcile: async () => { assert.fail('Targeted requests must never sweep the queue'); },
    reconcileSubmission: async (_db, options) => {
      calls.push(options);
      return { scope: 'submission', submissionId: options.submissionId, finalized: 1, errors: [] };
    },
    createReporter: () => async () => {},
  });
  try {
    process.env.CRON_SECRET = 'fixture-cron-secret';
    const headers = { authorization: 'Bearer fixture-cron-secret' };
    for (const url of [
      '/', '/?submission_id=', '/?submission_id=not-a-uuid',
      `/?submission_id=${id}&submission_id=${id}`,
    ]) {
      const res = response();
      await handler({ method: 'GET', headers, url }, res);
      assert.equal(res.statusCode, 400);
      assert.equal(calls.length, 0);
    }
    let res = response();
    await handler({ method: 'GET', headers, query: { submission_id: [id, id] } }, res);
    assert.equal(res.statusCode, 400);
    res = response();
    await handler({ method: 'GET', headers: {}, url: `/?submission_id=${id}` }, res);
    assert.equal(res.statusCode, 401);
    assert.equal(calls.length, 0);
    res = response();
    await handler({ method: 'GET', headers, url: `/?submission_id=${id}` }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.scope, 'submission');
    assert.equal(res.body.submissionId, id);
    assert.deepEqual(calls, [{ submissionId: id, timeBudgetMs: 40_000 }]);
  } finally {
    if (originalSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalSecret;
  }
});