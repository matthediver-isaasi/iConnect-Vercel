import assert from 'node:assert/strict';
import test from 'node:test';
import { makeCpdPointsReplayHandler, normalizeReplayScope, replayTokenCodec } from './eventCpdPointsReprocessing.js';

const tenant = '10000000-0000-0000-0000-000000000001';
const event = '20000000-0000-0000-0000-000000000001';
const booking = '30000000-0000-0000-0000-000000000001';
const request = '40000000-0000-0000-0000-000000000001';
const scope = { mode: 'selected', registrations: [{ booking_id: booking, event_id: event, booking_source: 'standard' }] };
const context = { tenantId: tenant, tenantUserId: 'admin', roleId: 'role', isAuthenticated: true };
const response = () => ({ code: null, body: null, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } });
function fixture(overrides = {}) {
  const calls = [];
  const handler = makeCpdPointsReplayHandler({
    db: { rpc: async (name, args) => {
      calls.push({ name, args });
      if (name === 'preview_event_cpd_points_reprocessing') return { data: {
        rows: [{ booking_id: booking, outcome: 'eligible' }], complete: true, digest: 'trusted-server-digest',
        totals: { registrations: 1, eligible: 1, proposed_points: '0.100001' },
      } };
      return { data: { replay_id: request, enqueued_count: 1 } };
    } },
    getContext: async () => context, hasAdminAccess: async () => true,
    hasFeatureAccess: async () => true, signingSecret: 'test-only-secret', ...overrides,
  });
  return { calls, async invoke(body, method = 'POST') {
    const res = response();
    await handler({ method, body, query: body }, res);
    return res;
  } };
}
test('preview is read only; signed contract controls confirmation and exact retry identity', async () => {
  const f = fixture();
  const preview = await f.invoke({ action: 'preview', scope });
  assert.equal(preview.code, 200);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].name, 'preview_event_cpd_points_reprocessing');
  const body = { action: 'confirm', confirmed: true, reason: 'Recovery', request_id: request, preview_token: preview.body.preview_token,
    scope: { mode: 'all_event', event_id: request, event_type: 'complex' } };
  assert.equal((await f.invoke(body)).code, 202);
  assert.equal((await f.invoke(body)).code, 202);
  assert.deepEqual(f.calls[1], f.calls[2]);
  assert.deepEqual(f.calls[1].args.p_scope, scope, 'altered client scope cannot replace reviewed scope');
  assert.equal(f.calls[1].args.p_digest, 'trusted-server-digest');
});
test('admin, feature, tenant mismatch and identity gates execute before database reads', async () => {
  for (const [overrides, expected] of [
    [{ getContext: async () => null }, 401],
    [{ getContext: async () => ({ ...context, tenantMismatch: true }) }, 409],
    [{ hasAdminAccess: async () => false }, 403],
    [{ hasFeatureAccess: async () => false }, 403],
    [{ getContext: async () => ({ ...context, tenantUserId: null }) }, 403],
  ]) {
    const f = fixture(overrides);
    for (const [body, method] of [[{ action: 'preview', scope }, 'POST'], [{ replay_id: request }, 'GET']]) {
      assert.equal((await f.invoke(body, method)).code, expected);
    }
    assert.equal(f.calls.length, 0);
  }
});
test('token tampering, tenant changes, actor changes, expiration and partial confirmation are rejected', async () => {
  const codec = replayTokenCodec('test-only-secret');
  const payload = { tenant, actor: 'tenant_user:admin', expires: Date.now() + 60000, scope,
    complete: false, totals: { eligible: 1 } };
  const token = codec.encode(payload);
  assert.throws(() => codec.decode(`${token}x`, tenant, payload.actor), /Invalid/);
  assert.throws(() => codec.decode(token, request, payload.actor), /another/);
  assert.throws(() => codec.decode(token, tenant, 'tenant_user:other'), /another/);
  assert.throws(() => codec.decode(codec.encode({ ...payload, expires: 1 }), tenant, payload.actor), /expired/);
  const f = fixture();
  assert.equal((await f.invoke({ action: 'confirm', confirmed: true, reason: 'Recovery', request_id: request, preview_token: token })).code, 400);
  assert.equal(f.calls.length, 0);
});
test('selected source identity is preserved, duplicates collapse, invalid and conflicting scopes fail', () => {
  assert.equal(normalizeReplayScope({ ...scope, registrations: [...scope.registrations, ...scope.registrations] }).registrations.length, 1);
  assert.equal(normalizeReplayScope({ ...scope, registrations: [...scope.registrations, { ...scope.registrations[0], booking_source: 'complex' }] }).registrations.length, 2);
  assert.throws(() => normalizeReplayScope({ ...scope, registrations: [...scope.registrations, { ...scope.registrations[0], event_id: request }] }), /two events/);
  assert.throws(() => normalizeReplayScope({ mode: 'all_event', event_id: event }), /event type/);
  assert.throws(() => normalizeReplayScope({ mode: 'selected', registrations: [] }), /between/);
});
test('database/provider failures cannot produce successful previews and old unchecked replay route is disabled', async () => {
  const f = fixture({ db: { rpc: async () => ({ error: { message: 'provider relation unavailable' } }) } });
  assert.equal((await f.invoke({ action: 'preview', scope })).code, 503);
  assert.equal((await f.invoke({ event_id: event, event_type: 'simple', trigger: 'registration', reason: 'old flow' })).code, 400);
});
test('per-registration evaluation errors are retained for review without signing continuation or confirmation authority', async () => {
  const rows = [{ booking_id: booking, outcome: 'evaluation_error', proposed_points: '0' }];
  const f = fixture({ db: { rpc: async () => ({ data: {
    rows, totals: { registrations: 1, eligible: 0, proposed_points: '0' },
    complete: false, evaluation_failed: true,
  } }) } });
  const response = await f.invoke({ action: 'preview', scope });
  assert.equal(response.code, 200);
  assert.deepEqual(response.body.rows, rows);
  assert.equal(response.body.complete, false);
  assert.equal(response.body.evaluation_failed, true);
  assert.equal(response.body.cursor, null);
  assert.equal(response.body.preview_token, null);
});