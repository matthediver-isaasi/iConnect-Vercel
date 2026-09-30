import assert from 'node:assert/strict';
import test from 'node:test';
import { createSalesAllocationsHandler } from './[...path].js';
process.env.SESSION_SECRET = 'test-only-session-secret-at-least-32-bytes';

function response() {
  return {
    statusCode: 0, body: null,
    setHeader() {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

const tenantId = '00000000-0000-4000-8000-000000000001';
const allocationId = '30000000-0000-4000-8000-000000000001';
const actorId = '10000000-0000-4000-8000-000000000001';
const context = {
  tenantId, id: allocationId, eventKind: 'simple', eventId: 'event-1',
  eventSlug: 'event-one', eventName: 'Event one', ticketTypeId: 'ticket-1',
  ticketName: 'Delegate', organizationId: 'org-1', organizationName: 'Org',
  delegateEmail: 'delegate@example.test', expiresAt: '2030-01-01T00:00:00.000Z',
  totals: {},
};

function inviteHandler(overrides = {}) {
  const calls = [];
  return {
    calls,
    handler: createSalesAllocationsHandler({
      db: {
        async rpc(name, args) {
          calls.push([name, args]);
          if (name === 'reserve_sales_allocation_invitation') {
            return { data: { invitationId: 'invite-1', expiresAt: args.p_expires_at }, error: null };
          }
          if (name === 'release_sales_allocation_invitation') return { data: { released: true }, error: null };
          return { data: null, error: null };
        },
      },
      getTenantContext: async () => ({ isAuthenticated: true, tenantId, tenantUserId: actorId }),
      getPublicAllocationInvitationContext: async () => context,
      getTrustedBaseUrlForTenant: async () => 'https://trusted.example',
      sendEmail: async () => ({ success: true }),
      ...overrides,
    }),
  };
}

const request = () => ({
  method: 'POST',
  query: { path: [allocationId, 'invite'] },
  body: {
    email: 'delegate@example.test',
    expiresAt: '2030-01-01T00:00:00.000Z',
    idempotencyKey: 'invite-one',
  },
});

test('invite route sends canonical secure handoff URL by default', async () => {
  let message;
  const { handler } = inviteHandler({ sendEmail: async (input) => { message = input; return { success: true }; } });
  const res = response();
  await handler(request(), res);
  assert.equal(res.statusCode, 201);
  assert.match(res.body.registration_url, /^https:\/\/trusted\.example\/events\/event-one\?allocation=/);
  assert.equal(res.body.email_sent, true);
  assert.equal(message.to, 'delegate@example.test');
  assert.match(message.text, /https:\/\/trusted\.example/);
});

test('direct registration suppresses delivery but still returns registration URL', async () => {
  let sent = false;
  const { handler } = inviteHandler({ sendEmail: async () => { sent = true; return { success: true }; } });
  const req = request();
  req.body.sendEmail = false;
  const res = response();
  await handler(req, res);
  assert.equal(res.statusCode, 201);
  assert.equal(sent, false);
  assert.ok(res.body.registration_url);
});

test('email failure releases reserved place and surfaces an actionable error', async () => {
  const { handler, calls } = inviteHandler({ sendEmail: async () => ({ success: false, error: 'provider unavailable' }) });
  const res = response();
  await handler(request(), res);
  assert.equal(res.statusCode, 502);
  assert.match(res.body.error, /reserved place was released/i);
  assert.ok(calls.some(([name]) => name === 'release_sales_allocation_invitation'));
});

test('duplicate API retry returns the same context token and registration URL', async () => {
  let reserves = 0;
  const { handler, calls } = inviteHandler({
    db: {
      async rpc(name, args) {
        calls.push([name, args]);
        if (name === 'reserve_sales_allocation_invitation') {
          reserves += 1;
          return { data: {
            invitationId: 'invite-1', expiresAt: '2030-01-01T00:00:00.000Z',
            replayed: reserves > 1,
          }, error: null };
        }
        return { data: null, error: null };
      },
    },
  });
  const first = response();
  const retry = response();
  await handler(request(), first);
  await handler(request(), retry);
  assert.equal(first.body.context_token, retry.body.context_token);
  assert.equal(first.body.registration_url, retry.body.registration_url);
  const reserveCalls = calls.filter(([name]) => name === 'reserve_sales_allocation_invitation');
  assert.equal(reserveCalls[0][1].p_token_hash, reserveCalls[1][1].p_token_hash);
});

test('retry after email-triggered release conflicts without sending an inactive link', async () => {
  let released = false;
  let sends = 0;
  const calls = [];
  const handler = createSalesAllocationsHandler({
    db: {
      async rpc(name, args) {
        calls.push([name, args]);
        if (name === 'reserve_sales_allocation_invitation') {
          if (released) {
            return {
              data: null,
              error: {
                code: '23514',
                message: 'invitation request key is no longer reusable; use a new idempotency key',
              },
            };
          }
          return { data: { invitationId: 'invite-1', expiresAt: args.p_expires_at }, error: null };
        }
        if (name === 'release_sales_allocation_invitation') {
          released = true;
          return { data: { released: true }, error: null };
        }
        return { data: null, error: null };
      },
    },
    getTenantContext: async () => ({ isAuthenticated: true, tenantId, tenantUserId: actorId }),
    getPublicAllocationInvitationContext: async () => context,
    getTrustedBaseUrlForTenant: async () => 'https://trusted.example',
    sendEmail: async () => { sends += 1; return { success: false, error: 'provider unavailable' }; },
  });
  const first = response();
  const retry = response();
  await handler(request(), first);
  await handler(request(), retry);
  assert.equal(first.statusCode, 502);
  assert.equal(retry.statusCode, 409);
  assert.match(retry.body.error, /new idempotency key/i);
  assert.equal(sends, 1);
  assert.equal(retry.body.registration_url, undefined);
});

test('expired idempotency retry conflicts before link generation or delivery', async () => {
  let sends = 0;
  let contextLookups = 0;
  const { handler } = inviteHandler({
    db: {
      async rpc(name) {
        if (name === 'reserve_sales_allocation_invitation') {
          return {
            data: null,
            error: {
              code: '23514',
              message: 'invitation request key is no longer reusable; use a new idempotency key',
            },
          };
        }
        return { data: null, error: null };
      },
    },
    getPublicAllocationInvitationContext: async () => { contextLookups += 1; return context; },
    sendEmail: async () => { sends += 1; return { success: true }; },
  });
  const res = response();
  await handler(request(), res);
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /new idempotency key/i);
  assert.equal(contextLookups, 0);
  assert.equal(sends, 0);
  assert.equal(res.body.registration_url, undefined);
});