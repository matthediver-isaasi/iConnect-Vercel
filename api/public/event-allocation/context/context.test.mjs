import assert from 'node:assert/strict';
import test from 'node:test';
import { createAllocationContextHandler } from './[token].js';

function response() {
  return {
    statusCode: 0,
    body: null,
    setHeader() {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

const trusted = {
  tenantId: 'tenant-1',
  id: 'allocation-1',
  eventKind: 'simple',
  eventId: 'event-1',
  eventSlug: 'annual-event',
  eventName: 'Annual event',
  ticketTypeId: 'ticket-1',
  ticketName: 'Delegate',
  organizationId: 'org-1',
  organizationName: 'Organisation',
  delegateEmail: 'delegate@example.test',
  expiresAt: '2030-01-01T00:00:00.000Z',
  totals: { purchased: 2, registered: 1, reserved: 1, released: 0, remaining: 2 },
};

test('public allocation context validates request tenant and returns only handoff contract', async () => {
  const handler = createAllocationContextHandler({
    db: {},
    resolveTenantFromRequest: async () => ({ id: 'tenant-1' }),
    getPublicAllocationInvitationContext: async () => trusted,
  });
  const res = response();
  await handler({ method: 'GET', query: { token: 'opaque-token' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.eventId, 'event-1');
  assert.equal(res.body.tenantId, undefined);
  assert.equal(res.body.token_hash, undefined);
});

test('public allocation context fails closed for a tenant mismatch', async () => {
  const handler = createAllocationContextHandler({
    db: {},
    resolveTenantFromRequest: async () => ({ id: 'another-tenant' }),
    getPublicAllocationInvitationContext: async () => trusted,
  });
  const res = response();
  await handler({ method: 'GET', query: { token: 'opaque-token' } }, res);
  assert.equal(res.statusCode, 404);
  assert.match(res.body.error, /not found/i);
});