// GoCardless Phase 5 — renewal decision logic tests.
// Run: node --test api/_lib/gocardlessDdRenewals.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveNextYearLabel,
  computeRenewalWindow,
  decideRenewalAction,
  RENEWAL_NOTICE_DAYS,
} from './gocardlessDdRenewals.js';
import { STATUS } from './gocardlessState.js';

// ---------------------------------------------------------------------------
// deriveNextYearLabel

test('deriveNextYearLabel handles slash short form', () => {
  assert.equal(deriveNextYearLabel('2026/27'), '2027/28');
});

test('deriveNextYearLabel handles dash short form', () => {
  assert.equal(deriveNextYearLabel('2026-27'), '2027-28');
});

test('deriveNextYearLabel handles long forms', () => {
  assert.equal(deriveNextYearLabel('2026/2027'), '2027/2028');
  assert.equal(deriveNextYearLabel('2026-2027'), '2027-2028');
});

test('deriveNextYearLabel handles plain year', () => {
  assert.equal(deriveNextYearLabel('2026'), '2027');
});

test('deriveNextYearLabel pads century rollover short form', () => {
  assert.equal(deriveNextYearLabel('2098/99'), '2099/00');
});

test('deriveNextYearLabel returns null for garbage', () => {
  assert.equal(deriveNextYearLabel('banana'), null);
  assert.equal(deriveNextYearLabel(''), null);
  assert.equal(deriveNextYearLabel(null), null);
  assert.equal(deriveNextYearLabel(undefined), null);
});

// ---------------------------------------------------------------------------
// computeRenewalWindow

test('computeRenewalWindow derives year end + notice date', () => {
  const w = computeRenewalWindow({ membership_year_start: '2026-04-01' });
  assert.equal(w.yearEnd.toISOString().slice(0, 10), '2027-04-01');
  const expectedNotice = new Date(w.yearEnd.getTime() - RENEWAL_NOTICE_DAYS * 86_400_000);
  assert.equal(w.noticeDate.getTime(), expectedNotice.getTime());
});

test('computeRenewalWindow honours custom notice days', () => {
  const w = computeRenewalWindow({ membership_year_start: '2026-04-01' }, 10);
  assert.equal((w.yearEnd - w.noticeDate) / 86_400_000, 10);
});

test('computeRenewalWindow returns null without a start date', () => {
  assert.equal(computeRenewalWindow({}), null);
  assert.equal(computeRenewalWindow(null), null);
  assert.equal(computeRenewalWindow({ membership_year_start: 'not-a-date' }), null);
});

// ---------------------------------------------------------------------------
// decideRenewalAction

const SNAP = { kind: 'monthly_direct_debit', membership_year: '2026/27', membership_year_start: '2026-04-01' };
const beforeNotice = new Date('2027-01-01T00:00:00Z');
const inNotice = new Date('2027-03-15T00:00:00Z');   // after notice (2027-03-02), before year end
const afterYearEnd = new Date('2027-04-02T00:00:00Z');

test('non-DD snapshot -> none', () => {
  const d = decideRenewalAction({ snapshot: { kind: 'other' }, planStatus: STATUS.ACTIVE, autoRenew: true, renewalRow: null, today: inNotice });
  assert.equal(d.action, 'none');
});

test('non-renewable plan status -> none', () => {
  for (const status of ['cancelled', 'suspended', null]) {
    const d = decideRenewalAction({ snapshot: SNAP, planStatus: status, autoRenew: true, renewalRow: null, today: inNotice });
    assert.equal(d.action, 'none', `status ${status}`);
  }
});

test('before notice window -> none', () => {
  const d = decideRenewalAction({ snapshot: SNAP, planStatus: STATUS.ACTIVE, autoRenew: true, renewalRow: null, today: beforeNotice });
  assert.equal(d.action, 'none');
});

test('in notice window, no row -> send_notice with mode from tier autoRenew', () => {
  const auto = decideRenewalAction({ snapshot: SNAP, planStatus: STATUS.ACTIVE, autoRenew: true, renewalRow: null, today: inNotice });
  assert.deepEqual({ action: auto.action, mode: auto.mode }, { action: 'send_notice', mode: 'auto' });
  const confirm = decideRenewalAction({ snapshot: SNAP, planStatus: STATUS.EXPIRED, autoRenew: false, renewalRow: null, today: inNotice });
  assert.deepEqual({ action: confirm.action, mode: confirm.mode }, { action: 'send_notice', mode: 'confirm' });
});

test('next year already recorded elsewhere -> none (never a parallel charge)', () => {
  const d = decideRenewalAction({ snapshot: SNAP, planStatus: STATUS.ACTIVE, autoRenew: true, renewalRow: null, hasNextYearRecord: true, today: inNotice });
  assert.equal(d.action, 'none');
});

test('notice sent, before year end -> none (waiting)', () => {
  const d = decideRenewalAction({
    snapshot: SNAP, planStatus: STATUS.ACTIVE, autoRenew: true,
    renewalRow: { status: 'notice_sent', mode: 'auto' }, today: inNotice,
  });
  assert.equal(d.action, 'none');
});

test('notice sent, after year end, auto mode -> renew_auto', () => {
  const d = decideRenewalAction({
    snapshot: SNAP, planStatus: STATUS.EXPIRED, autoRenew: true,
    renewalRow: { status: 'notice_sent', mode: 'auto' }, today: afterYearEnd,
  });
  assert.equal(d.action, 'renew_auto');
});

test('notice sent, after year end, confirm mode -> await_confirmation', () => {
  const d = decideRenewalAction({
    snapshot: SNAP, planStatus: STATUS.EXPIRED, autoRenew: false,
    renewalRow: { status: 'notice_sent', mode: 'confirm' }, today: afterYearEnd,
  });
  assert.equal(d.action, 'await_confirmation');
});

test('terminal renewal rows -> none (idempotent)', () => {
  for (const status of ['renewed', 'confirmed', 'declined', 'failed']) {
    const d = decideRenewalAction({
      snapshot: SNAP, planStatus: STATUS.EXPIRED, autoRenew: true,
      renewalRow: { status, mode: 'auto' }, today: afterYearEnd,
    });
    assert.equal(d.action, 'none', `renewal status ${status}`);
  }
});
