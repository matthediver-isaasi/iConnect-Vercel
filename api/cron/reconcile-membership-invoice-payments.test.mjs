import test from 'node:test';
import assert from 'node:assert/strict';
import handler, { isAuthorizedMembershipInvoiceCron } from './reconcile-membership-invoice-payments.js';

test('membership invoice cron denies absent/blank secret and incorrect bearer before all financial work', async () => {
  for (const secret of [undefined, '', ' ', 'test-secret']) {
    assert.equal(isAuthorizedMembershipInvoiceCron({ headers: {} }, secret), false);
    assert.equal(isAuthorizedMembershipInvoiceCron({ headers: { authorization: 'Bearer wrong' } }, secret), false);
  }
  assert.equal(isAuthorizedMembershipInvoiceCron({ headers: { authorization: 'Bearer test-secret' } }, 'test-secret'), true);
  const previous = process.env.CRON_SECRET;
  try {
    delete process.env.CRON_SECRET;
    const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await handler({ headers: {} }, res);
    assert.equal(res.code, 401);
    assert.deepEqual(res.body, { error: 'Unauthorized' });
  } finally {
    if (previous === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previous;
  }
});
