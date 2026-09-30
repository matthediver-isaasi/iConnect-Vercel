import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clearEventClickRateLimits,
  consumeEventClickRateLimit,
  deriveEventClickVisitorHash,
  isDerivedEventClickVisitorHash,
  isUuid,
} from './eventClickTracking.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const visitorId = '22222222-2222-4222-8222-222222222222';

test('visitor identifiers are strict UUIDs and derive to opaque fixed-length hashes', () => {
  assert.equal(isUuid(visitorId), true);
  assert.equal(isUuid('visitor-1'), false);
  assert.equal(isUuid('22222222-2222-4222-c222-222222222222'), false);

  const digest = deriveEventClickVisitorHash(tenantId, visitorId, 'test-secret');
  assert.equal(isDerivedEventClickVisitorHash(digest), true);
  assert.equal(digest.includes(visitorId), false);
  assert.equal(digest, deriveEventClickVisitorHash(tenantId, visitorId.toUpperCase(), 'test-secret'));
  assert.notEqual(
    digest,
    deriveEventClickVisitorHash('33333333-3333-4333-8333-333333333333', visitorId, 'test-secret'),
  );
});

test('event click rate limit is bounded and resets after the window', () => {
  clearEventClickRateLimits();
  const key = 'tenant:edge';
  for (let i = 0; i < 60; i += 1) {
    assert.equal(consumeEventClickRateLimit(key, 100_000 + i).allowed, true);
  }
  const blocked = consumeEventClickRateLimit(key, 100_200);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSeconds >= 1);
  assert.equal(consumeEventClickRateLimit(key, 161_000).allowed, true);
  clearEventClickRateLimits();
});