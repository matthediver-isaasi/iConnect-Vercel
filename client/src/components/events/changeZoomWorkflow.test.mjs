import test from 'node:test';
import assert from 'node:assert/strict';
import { createZoomOperation, runZoomOperation } from './changeZoomWorkflow.mjs';

const empty = { zoom_webinar_id: null, zoom_meeting_id: null };
const chosen = { zoom_webinar_id: 'local-webinar', zoom_meeting_id: null };
const body = { ...chosen, cancelOld: true, registerNew: true, resendConfirmations: false, enableRegistration: true };

for (const kind of ['event', 'session']) {
  test(`${kind}: 43 bookings attach, then 25 + 18 from cursor null`, async () => {
    const op = createZoomOperation(body, empty);
    const requests = [];
    await runZoomOperation(op, async request => {
      requests.push(request);
      if (requests.length === 1) return { missingEmail: 3, nextCursor: 'IGNORE-ATTACH-CURSOR' };
      if (requests.length === 2) return { registered: 25, nextCursor: 'booking-25' };
      return { registered: 18, nextCursor: null };
    });
    assert.deepEqual(requests[0], { ...body, cancelOld: false, registerNew: false, resendConfirmations: false, enableRegistration: false, afterBookingId: null });
    assert.deepEqual(requests.slice(1).map(r => r.afterBookingId), [null, 'booking-25']);
    assert.ok(requests.every(r => !r.cancelOld && !r.resendConfirmations));
    assert.equal(requests[1].enableRegistration, true);
    assert.equal(op.totals.registered, 43);
    assert.equal(op.totals.missingEmail, 0);
    assert.equal(op.done, true);
  });
}

test('attach-only is one request even when the server returns a cursor', async () => {
  const op = createZoomOperation({ ...body, registerNew: false }, empty);
  let calls = 0;
  await runZoomOperation(op, async request => {
    calls++;
    assert.equal(request.enableRegistration, false);
    assert.equal(request.resendConfirmations, false);
    return { nextCursor: 'unexpected' };
  });
  assert.equal(calls, 1);
  assert.equal(op.done, true);
});

test('same target reconcile batches directly and never cancels', async () => {
  const op = createZoomOperation(body, chosen);
  const requests = [];
  await runZoomOperation(op, async request => {
    requests.push(request);
    return { existing: requests.length === 1 ? 25 : 18, nextCursor: requests.length === 1 ? '25' : null };
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].registerNew, true);
  assert.ok(requests.every(r => r.cancelOld === false));
  assert.equal(op.totals.existing, 43);
});

test('replacement is not split; server >25 cancellation guard is preserved', async () => {
  const op = createZoomOperation(body, { ...empty, zoom_meeting_id: 'old-meeting' });
  let calls = 0;
  await assert.rejects(runZoomOperation(op, async request => {
    calls++;
    assert.equal(request.cancelOld, true);
    assert.equal(request.registerNew, true);
    throw new Error('409: For more than 25 bookings, attach without attendee actions first');
  }), /409/);
  assert.equal(calls, 1);
  assert.equal(op.attached, false);
});

for (const failureAt of [2, 3]) {
  test(`failure in request ${failureAt}: retains attach, counters and email checkpoint on retry`, async () => {
    const op = createZoomOperation({ ...body, resendConfirmations: true }, empty);
    let calls = 0;
    const requests = [];
    const post = async request => {
      requests.push(request);
      calls++;
      if (calls === failureAt) throw new Error('network');
      if (calls === 1) return {};
      if (!request.afterBookingId) return { registered: 25, emailed: 25, errors: [{ phase: 'history', message: 'history failed' }], nextCursor: '25' };
      return { registered: 18, emailed: 18 };
    };
    await assert.rejects(runZoomOperation(op, post), /network/);
    assert.equal(op.attached, true);
    assert.equal(op.totals.emailed, failureAt === 3 ? 25 : 0);
    const checkpoint = op.cursor;
    await runZoomOperation(op, post);
    assert.equal(requests[failureAt].afterBookingId, checkpoint);
    assert.equal(requests.filter(r => !r.registerNew).length, 1);
    assert.equal(op.totals.registered, 43);
    assert.equal(op.totals.emailed, 43);
    assert.equal(op.totals.errors.length, 1);
    const completeCalls = calls;
    await runZoomOperation(op, post);
    assert.equal(calls, completeCalls, 'completed work cannot resend');
  });
}

test('email-only opt-in attaches without emails then sends in attendee phase', async () => {
  const op = createZoomOperation({ ...body, registerNew: false, resendConfirmations: true }, empty);
  const requests = [];
  await runZoomOperation(op, async request => { requests.push(request); return {}; });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].resendConfirmations, false);
  assert.equal(requests[1].resendConfirmations, true);
  assert.equal(requests[1].registerNew, false);
});

test('unknown current target fails closed, never inferred as initial attach', () => {
  assert.throws(() => createZoomOperation(body, null), /verify/);
  assert.throws(() => createZoomOperation(body, {}), /verify/);
});
