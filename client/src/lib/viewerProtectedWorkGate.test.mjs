import test from 'node:test';
import assert from 'node:assert/strict';
import {
  installViewerProtectedWorkGate,
  setViewerProtectedWorkPaused,
  isProtectedViewerRequest,
  viewerSessionFailureRetainsWorkPause,
} from './viewerProtectedWorkGate.js';

test('blocked retained pages reject protected direct fetches and mutations without sending or replaying', async () => {
  const requests = [];
  const target = {
    location: { origin: 'https://portal.example' },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: true };
    },
  };
  const cleanup = installViewerProtectedWorkGate(target);
  try {
    setViewerProtectedWorkPaused(true);
    for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
      await assert.rejects(target.fetch('/api/entities/Booking', { method }),
        error => error.code === 'VIEWER_SESSION_WORK_PAUSED');
    }
    assert.equal(requests.length, 0);
    await target.fetch('/api/auth/me');
    await target.fetch('/api/auth/logout', { method: 'POST' });
    await target.fetch('/api/public/system-setting');
    assert.equal(requests.length, 3);
    setViewerProtectedWorkPaused(false);
    assert.equal(requests.length, 3, 'unpausing never replays mutations');
    await target.fetch('/api/entities/Booking');
    assert.equal(requests.length, 4);
  } finally {
    cleanup();
  }
});

test('confirmed guest and logout transitions release recovery-only gating for guest booking and Stripe workflows', async () => {
  const requests = [];
  const target = {
    location: { origin: 'https://portal.example' },
    fetch: async (url, options) => { requests.push({ url, options }); return { ok: true }; },
  };
  const cleanup = installViewerProtectedWorkGate(target);
  try {
    assert.equal(viewerSessionFailureRetainsWorkPause(false, true), false, 'cold confirmed guest');
    assert.equal(viewerSessionFailureRetainsWorkPause(false, false), false, 'no validated member to retain');
    assert.equal(viewerSessionFailureRetainsWorkPause(true, false), true, 'retained member transport failure');
    assert.equal(viewerSessionFailureRetainsWorkPause(true, true), false, 'confirmed logout discards member state');
    setViewerProtectedWorkPaused(true);
    await assert.rejects(target.fetch('/api/functions/createOneOffEventBooking', { method: 'POST' }),
      error => error.code === 'VIEWER_SESSION_WORK_PAUSED');
    // Mirrors Layout committing null identity after authoritative validation
    // (including 200/null) or after logout, before returning to public workflow.
    setViewerProtectedWorkPaused(viewerSessionFailureRetainsWorkPause(false, true));
    for (const name of ['createJobPostingNonMember', 'createOneOffEventBooking',
      'createStripePaymentIntent', 'getStripePublishableKey']) {
      await target.fetch(`/api/functions/${name}`, { method: 'POST' });
    }
    assert.equal(requests.length, 4, 'guest requests execute once, never queued or replayed');
  } finally {
    cleanup();
  }
});

test('function exceptions are exact, method-scoped, guest-only operations rather than a protected mutation bypass', async () => {
  const origin = 'https://portal.example';
  for (const name of ['createJobPostingNonMember', 'createJobPostingPaymentIntent',
    'checkMemberStatusByEmail', 'getStripePublishableKey']) {
    assert.equal(isProtectedViewerRequest(`/api/functions/${name}`, origin, { method: 'POST' }), false);
  }
  for (const name of ['createJobPostingMember', 'createOneOffEventBooking', 'createBooking',
    'createStripePaymentIntent', 'clearBookings', 'updateOrganizationNote', 'sendTeamMemberInvite',
    'createJobPostingNonMember/extra', 'createJobPostingNonMemberAdmin']) {
    assert.equal(isProtectedViewerRequest(`/api/functions/${name}`, origin, { method: 'POST' }), true);
  }
  assert.equal(isProtectedViewerRequest('/api/functions/createJobPostingNonMember', origin, { method: 'DELETE' }), true);
  assert.equal(isProtectedViewerRequest(new Request(`${origin}/api/functions/createJobPostingNonMember`, { method: 'POST' }), origin), false);
  const calls = [];
  const target = { location: { origin }, fetch: async url => { calls.push(url); return { ok: true }; } };
  const cleanup = installViewerProtectedWorkGate(target);
  try {
    setViewerProtectedWorkPaused(true);
    await target.fetch('/api/functions/createJobPostingNonMember', { method: 'POST' });
    await assert.rejects(target.fetch('/api/functions/createJobPostingMember', { method: 'POST' }),
      error => error.code === 'VIEWER_SESSION_WORK_PAUSED');
    await assert.rejects(target.fetch('/api/functions/createStripePaymentIntent', { method: 'POST' }),
      error => error.code === 'VIEWER_SESSION_WORK_PAUSED');
    assert.deepEqual(calls, ['/api/functions/createJobPostingNonMember']);
  } finally {
    cleanup();
  }
});

test('protected responses started before a pause cannot cross the recovery epoch', async () => {
  let finish;
  const target = {
    location: { origin: 'https://portal.example' },
    fetch: () => new Promise(resolve => { finish = resolve; }),
  };
  const cleanup = installViewerProtectedWorkGate(target);
  try {
    const pending = target.fetch('/api/entities/Booking');
    setViewerProtectedWorkPaused(true);
    setViewerProtectedWorkPaused(false);
    finish({ ok: true });
    await assert.rejects(pending, error => error.code === 'VIEWER_SESSION_WORK_PAUSED');
  } finally {
    cleanup();
  }
});

test('request classification covers URL and Request objects without blocking external/public work', () => {
  const origin = 'https://portal.example';
  assert.equal(isProtectedViewerRequest(new URL(`${origin}/api/entities/Booking`), origin), true);
  assert.equal(isProtectedViewerRequest(new Request(`${origin}/api/functions/book`), origin), true);
  assert.equal(isProtectedViewerRequest('https://external.example/api/entities/Booking', origin), false);
  assert.equal(isProtectedViewerRequest('/api/public/page/my-page', origin), false);
});

test('body parsing cannot publish protected data after readiness closes', async () => {
  let finishBody;
  const target = {
    location: { origin: 'https://portal.example' },
    fetch: async () => ({ json: () => new Promise(resolve => { finishBody = resolve; }) }),
  };
  const cleanup = installViewerProtectedWorkGate(target);
  try {
    const response = await target.fetch('/api/entities/Booking');
    const body = response.json();
    setViewerProtectedWorkPaused(true);
    finishBody([{ id: 'late' }]);
    await assert.rejects(body, error => error.code === 'VIEWER_SESSION_WORK_PAUSED');
  } finally {
    cleanup();
  }
});