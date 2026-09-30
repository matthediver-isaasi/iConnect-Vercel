import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { handleStripeMembershipWebhook } from './stripe-membership.js';

class FakeStripe {
  static webhooks = {
    constructEvent(raw, signature, secret) {
      assert.equal(signature, 'signed');
      assert.equal(secret, 'whsec_live');
      return JSON.parse(raw.toString('utf8'));
    },
  };

  constructor(key) {
    assert.equal(key, 'sk_live');
  }
}

function requestFor(event) {
  const req = new EventEmitter();
  req.method = 'POST';
  req.query = { tenant: 'tenant-1' };
  req.headers = { 'stripe-signature': 'signed' };
  setImmediate(() => {
    req.emit('data', Buffer.from(JSON.stringify(event)));
    req.emit('end');
  });
  return req;
}

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test('handler skips an irrelevant account-wide event before any payload DB call', async () => {
  let dbCalls = 0;
  const db = {
    from() {
      dbCalls += 1;
      throw new Error('irrelevant event must not touch payload storage');
    },
  };
  const res = response();
  await handleStripeMembershipWebhook(requestFor({
    id: 'evt_unrelated',
    livemode: true,
    type: 'payment_intent.succeeded',
    data: { object: { metadata: { booking_id: 'booking-1' } } },
  }), res, {
    db,
    StripeClient: FakeStripe,
    getStripeIntegrationCredentials: async () => ({
      membership_webhook_secret: 'whsec_live',
      secret_key: 'sk_live',
    }),
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { received: true, status: 'skipped' });
  assert.equal(dbCalls, 0);
});