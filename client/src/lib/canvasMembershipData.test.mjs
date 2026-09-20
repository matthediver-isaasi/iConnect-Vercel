import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getCanvasMembershipDefaults, normalizeCanvasMembershipContent, safeMembershipLink,
  normalizeCanvasMembershipSummary, formatMembershipDate, canvasMembershipQueryKey,
  MEMBERSHIP_DATA_STATES, MEMBERSHIP_PAYMENT_STATES, MEMBERSHIP_TEXT_ROLES,
} from './canvasMembershipData.js';

test('active existing mandate wording remains distinct from paid membership and new setup', () => {
  const defaults = getCanvasMembershipDefaults('payment-details');
  assert.equal(defaults.states.first_payment_pending.heading, 'Direct Debit mandate active');
  assert.equal(defaults.states.first_payment_pending.status, 'Awaiting first payment');
  assert.match(defaults.states.first_payment_pending.supporting, /does not establish membership entitlement/);
  assert.equal(defaults.states.pending.heading, 'Payment setup pending');
  const normalized = normalizeCanvasMembershipSummary({
    membership: { state: 'pending' }, payment: { state: 'first_payment_pending', method: 'direct_debit' },
  });
  assert.equal(normalized.membership.state, 'pending');
  assert.equal(normalized.payment.state, 'first_payment_pending');
});

test('presentation normalization excludes private records and preview samples', () => {
  const content = normalizeCanvasMembershipContent({
    memberId: 'private', sample: { name: 'Example' }, membership: { state: 'active' },
    states: { active: { heading: 'Welcome', privateData: 'secret' } },
    typography: { heading: 'tenant-heading', unknown: 'hidden' },
    panel: { borderWidth: -10, borderRadius: 999, background: 'var(--brand-panel)' },
  });
  assert.equal(content.states.active.heading, 'Welcome');
  assert.equal(content.states.paused.heading, 'Membership paused');
  assert.equal(content.typography.heading, 'tenant-heading');
  assert.deepEqual(Object.keys(content.typography), MEMBERSHIP_TEXT_ROLES);
  assert.equal(content.memberId, undefined);
  assert.equal(content.membership, undefined);
  assert.equal(content.sample, undefined);
  assert.equal(content.states.active.privateData, undefined);
  assert.equal(content.panel.borderWidth, 0);
  assert.equal(content.panel.borderRadius, 100);
  assert.equal(content.panel.background, 'var(--brand-panel)');
  assert.equal(content.minHeight, 0);
  assert.deepEqual(normalizeCanvasMembershipContent(JSON.parse(JSON.stringify(content))), content);
});

test('outer minimum height normalizes responsive Auto and custom values', () => {
  assert.equal(getCanvasMembershipDefaults().minHeight, 0);
  assert.equal(normalizeCanvasMembershipContent({ minHeight: 420 }).minHeight, 420);
  assert.deepEqual(
    normalizeCanvasMembershipContent({ minHeight: { desktop: 500, tablet: 0, mobile: 240 } }).minHeight,
    { desktop: 500, tablet: 0, mobile: 240 },
  );
  assert.deepEqual(
    normalizeCanvasMembershipContent({ minHeight: { desktop: -20, tablet: 9000, mobile: '320' } }).minHeight,
    { desktop: 0, tablet: 4000, mobile: 320 },
  );
  assert.equal(normalizeCanvasMembershipContent({ minHeight: { desktop: 'bad' } }).minHeight, 0);
});

test('every non-active state has independent non-success headings and support', () => {
  for (const type of ['membership-summary', 'payment-details']) {
    const defaults = getCanvasMembershipDefaults(type);
    const states = type === 'payment-details' ? MEMBERSHIP_PAYMENT_STATES : MEMBERSHIP_DATA_STATES;
    for (const state of states.filter(value => value !== 'active')) {
      assert.notEqual(defaults.states[state].heading, defaults.states.active.heading);
      assert.notEqual(defaults.states[state].supporting, defaults.states.active.supporting);
    }
    const first = getCanvasMembershipDefaults(type);
    first.states.active.heading = 'Changed';
    assert.notEqual(getCanvasMembershipDefaults(type).states.active.heading, 'Changed');
  }
});

test('paid is a payment state only and preserves paid-upfront term dates', () => {
  assert.equal(MEMBERSHIP_DATA_STATES.includes('paid'), false);
  assert.equal(MEMBERSHIP_PAYMENT_STATES.includes('paid'), true);
  const data = normalizeCanvasMembershipSummary({
    membership: {
      state: 'paid', memberSince: '2024-01-01', membershipType: 'Annual',
      renewalDate: '2030-04-15T00:00:00.000Z',
    },
    payment: { state: 'paid', method: 'card', nextPayment: null },
  });
  assert.equal(data.membership.state, 'unavailable');
  assert.equal(data.membership.membershipType, 'Annual');
  assert.equal(data.membership.renewalDate, '2030-04-15T00:00:00.000Z');
  assert.equal(data.payment.state, 'paid');
  assert.equal(data.payment.nextPayment, null);
  const paymentDefaults = getCanvasMembershipDefaults('payment-details');
  assert.deepEqual(paymentDefaults.states.paid, {
    heading: 'Membership paid',
    supporting: 'Your current membership has been paid in full.',
    status: 'Paid in full',
  });
  assert.equal(paymentDefaults.fields.renewalDate, 'Renewal date');
  assert.equal(paymentDefaults.messages.noPaymentScheduled, 'No scheduled payment recorded');
  assert.equal(getCanvasMembershipDefaults().states.paid, undefined);
});

test('manage links reject executable, network-path, credential and obfuscated URLs', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,x', '//evil.test', '/\\evil.test', 'https://user:pass@example.test', 'java\nscript:alert(1)', ' https://example.test/a b ', 'file:///etc/passwd']) {
    assert.equal(safeMembershipLink(url), '', url);
  }
  for (const url of ['/membership/payments', 'https://example.test/payments?q=1', '#payments']) {
    assert.equal(safeMembershipLink(url), url);
  }
  assert.equal(safeMembershipLink(null), '');
});

test('missing/unknown response evidence never implies membership or payment success', () => {
  const empty = normalizeCanvasMembershipSummary(null);
  assert.equal(empty.membership.state, 'unavailable');
  assert.equal(empty.payment.state, 'unavailable');
  assert.equal(empty.payment.method, 'unavailable');
  assert.equal(empty.membership.memberSince, null);
  const data = normalizeCanvasMembershipSummary({
    membership: { state: 'admin', memberSince: 'yesterday' },
    payment: { state: 'paused', method: 'monthly_card', nextPayment: '2029-10-01' },
  });
  assert.equal(data.membership.state, 'unavailable');
  assert.equal(data.payment.state, 'paused');
  assert.equal(data.payment.method, 'monthly_card');
  assert.equal(formatMembershipDate(data.payment.nextPayment), '1 October 2029');
  assert.equal(formatMembershipDate('2020-01-01', true), '2020');
  assert.equal(formatMembershipDate('not a date'), null);
});

test('cache scope segregates tenant, viewer, slug and host without block identity', () => {
  const base = { tenantId: 't1', tenantSlug: 'tenant', host: 'tenant.test', viewerId: 'm1' };
  for (const key of Object.keys(base)) {
    assert.notDeepEqual(canvasMembershipQueryKey(base), canvasMembershipQueryKey({ ...base, [key]: 'different' }));
  }
  assert.deepEqual(canvasMembershipQueryKey(base), canvasMembershipQueryKey({ ...base }));
});