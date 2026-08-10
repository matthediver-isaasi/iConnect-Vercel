/**
 * Task #3498 — client decision logic for membership-fee form payments.
 *
 * Unit tests for the React-free helpers plus source contracts pinning the
 * server quote action and the FormPaymentSubmit fallback gating.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  resolveMembershipMatch,
  membershipQuoteKey,
  resolveEffectivePayment,
} from './formPaymentQuote.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..', '..');

const membershipRule = {
  id: 'rule_1',
  trigger_field_id: 'field_class',
  operator: 'equals',
  value: 'Full member',
  actions: [{
    id: 'act_1',
    action_type: 'membership_structure',
    config_id: 'cfg-123',
    field_mappings: { 'core:member_count': 'field_staff' },
  }],
};

const form = {
  id: 'form-1',
  visibility_rules: [membershipRule],
  lmic_country_codes: null,
};

// ---------- resolveMembershipMatch ----------

test('matches the membership rule when the condition is met', () => {
  const match = resolveMembershipMatch(form, { field_class: 'Full member' });
  assert.equal(match?.configId, 'cfg-123');
});

test('no match when the condition fails or form is missing', () => {
  assert.equal(resolveMembershipMatch(form, { field_class: 'Associate' }), null);
  assert.equal(resolveMembershipMatch(null, {}), null);
});

// ---------- membershipQuoteKey ----------

test('key is null without a match', () => {
  assert.equal(membershipQuoteKey(null, {}), null);
});

test('key changes only when mapped answers change', () => {
  const match = resolveMembershipMatch(form, { field_class: 'Full member', field_staff: '10' });
  const k1 = membershipQuoteKey(match, { field_class: 'Full member', field_staff: '10', unrelated: 'a' });
  const k2 = membershipQuoteKey(match, { field_class: 'Full member', field_staff: '10', unrelated: 'b' });
  const k3 = membershipQuoteKey(match, { field_class: 'Full member', field_staff: '25' });
  assert.equal(k1, k2);
  assert.notEqual(k1, k3);
});

// ---------- resolveEffectivePayment ----------

test('no membership match: derived (price-source) amount, never blocked', () => {
  const r = resolveEffectivePayment({ membershipMatched: false, derivedAmount: 42.5, derivedCurrency: 'GBP' });
  assert.deepEqual([r.amount, r.blocked, r.pending], [42.5, false, false]);
});

test('membership match while loading: pending AND blocked (no unpaid fallback)', () => {
  const r = resolveEffectivePayment({ membershipMatched: true, quoteLoading: true, derivedAmount: 0 });
  assert.equal(r.pending, true);
  assert.equal(r.blocked, true);
  assert.equal(r.amount, null);
});

test('membership match with quote error: blocked with the error surfaced', () => {
  const r = resolveEffectivePayment({ membershipMatched: true, quoteError: 'boom', derivedAmount: 0 });
  assert.equal(r.blocked, true);
  assert.equal(r.error, 'boom');
  assert.equal(r.amount, null);
});

test('membership match with a quote: server amount/currency/context win over derived 0', () => {
  const r = resolveEffectivePayment({
    membershipMatched: true,
    quote: { required: true, amount: 185, currency: 'gbp', membership: { config_name: 'Full', membership_year: '2026-27' } },
    derivedAmount: 0,
    derivedCurrency: 'USD',
  });
  assert.equal(r.amount, 185);
  assert.equal(r.currency, 'GBP');
  assert.equal(r.membership.config_name, 'Full');
  assert.equal(r.blocked, false);
});

test('membership match but server says nothing due: plain submit allowed', () => {
  const r = resolveEffectivePayment({ membershipMatched: true, quote: { required: false }, derivedAmount: 0 });
  assert.equal(r.amount, 0);
  assert.equal(r.blocked, false);
});

// ---------- source contracts ----------

test('server form-payment endpoint wires the quote action through the shared resolver', () => {
  const src = readFileSync(join(repoRoot, 'api', 'public', 'form-payment.js'), 'utf8');
  assert.match(src, /action === 'quote'.*handleQuote/s, 'quote action must be routed');
  const quoteBody = src.slice(src.indexOf('async function handleQuote'), src.indexOf('async function handleCreate'));
  assert.match(quoteBody, /resolvePayableCharge/, 'quote must reuse the same charge resolver as create');
  assert.ok(!/\.insert\(|\.update\(/.test(quoteBody), 'quote must never write');
  assert.ok(!/req\.body[^\n]*amount/.test(quoteBody), 'quote must never read an amount from the client');
  const createBody = src.slice(src.indexOf('async function handleCreate'));
  assert.match(createBody, /resolvePayableCharge/, 'create must use the shared resolver');
});

test('handleCreate checks submit-control BEFORE resolving the charge (pre-existing ordering)', () => {
  const src = readFileSync(join(repoRoot, 'api', 'public', 'form-payment.js'), 'utf8');
  const createBody = src.slice(src.indexOf('async function handleCreate'));
  const submitIdx = createBody.indexOf('resolveSubmitControl(');
  const chargeIdx = createBody.indexOf('resolvePayableCharge(');
  assert.ok(submitIdx > -1 && chargeIdx > -1);
  assert.ok(submitIdx < chargeIdx, 'a disabled submit must short-circuit before any membership resolution');
});

test('FormView quote and submission payload share ONE resolved organisation id', () => {
  const src = readFileSync(join(repoRoot, 'client', 'src', 'pages', 'FormView.jsx'), 'utf8');
  assert.match(src, /prefillOrganizationId:\s*resolvedOrgIdForSubmission/, 'quote hook must use the shared memo');
  assert.match(src, /const resolvedOrganizationId = resolvedOrgIdForSubmission/, 'payload must use the shared memo');
});

test('FormPaymentSubmit blocks the unpaid fallback while a membership quote is unresolved', () => {
  const src = readFileSync(join(repoRoot, 'client', 'src', 'components', 'forms', 'FormPaymentSubmit.jsx'), 'utf8');
  assert.match(src, /!effective\.blocked\s*&&/, 'fallbackToNormalSubmit must be gated on effective.blocked');
  assert.match(src, /resolveEffectivePayment/, 'must use the shared decision helper');
});
