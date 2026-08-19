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
  const quoteBody = src.slice(
    src.indexOf('async function handleQuote'),
    src.indexOf('async function handleCreateMonthlyCard'),
  );
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

test('monthly card is shown with server-quoted amount, instalments, total, and currency', () => {
  const src = readFileSync(join(repoRoot, 'client', 'src', 'components', 'forms', 'FormPaymentSubmit.jsx'), 'utf8');
  assert.match(src, /effective\.membership\?\.monthly_card/, 'offer must be conditional on the server quote');
  assert.match(src, /Pay monthly by card/, 'choice must be clearly labelled');
  assert.match(src, /monthlyAmount/, 'label must show the monthly amount');
  assert.match(src, /instalmentCount/, 'label must show the instalment count');
  assert.match(src, /planTotal/, 'label must show the plan total');
  assert.match(src, /monthly_card\.currency \|\| currency/, 'offer currency must drive formatting');
});

test('monthly card starts a server-derived subscription checkout and preserves return recovery', () => {
  const src = readFileSync(join(repoRoot, 'client', 'src', 'components', 'forms', 'FormPaymentSubmit.jsx'), 'utf8');
  const monthly = src.slice(src.indexOf('const startMonthlyCard'), src.indexOf('const handleStripeConfirm'));
  assert.match(monthly, /action:\s*'create_monthly_card'/);
  assert.doesNotMatch(monthly, /\bamount\s*:/, 'browser must not submit a price');
  assert.match(monthly, /sessionStorage\.setItem\(SS_KEY,\s*json\.submissionId\)/);
  assert.ok(
    monthly.indexOf('sessionStorage.setItem') < monthly.indexOf('window.location.href'),
    'recovery id must be stored before leaving for Stripe',
  );
});

test('existing one-off card and Direct Debit choices remain wired', () => {
  const src = readFileSync(join(repoRoot, 'client', 'src', 'components', 'forms', 'FormPaymentSubmit.jsx'), 'utf8');
  assert.match(src, /action:\s*'create'/, 'one-off create action must remain');
  assert.match(src, /providerId === 'gocardless'/, 'GoCardless path must remain');
  assert.match(src, /\(usableProviders \|\| \[\]\)\.map/, 'configured one-off choices must still render');
  assert.match(src, /onClick=\{\(\) => startPayment\(p\.id\)\}/, 'one-off provider buttons must still start their provider');
});

test('server monthly checkout re-derives membership terms and uses durable idempotency', () => {
  const src = readFileSync(join(repoRoot, 'api', 'public', 'form-payment.js'), 'utf8');
  const monthly = src.slice(src.indexOf('async function handleCreateMonthlyCard'), src.indexOf('async function handleCreate('));
  assert.match(monthly, /resolvePayableCharge/, 'checkout must re-resolve answers and membership server-side');
  assert.doesNotMatch(monthly, /req\.body[^\n]*amount/, 'checkout must not accept a browser price');
  assert.match(monthly, /membership_billing_agreements/);
  assert.match(monthly, /idempotencyKey:\s*`form-card-session:/, 'Stripe session creation must be idempotent');
  assert.match(monthly, /mode:\s*'subscription'/);
  assert.match(monthly, /form_payment_submission/, 'success return must use shared form return parameters');
  assert.match(monthly, /form_payment_provider/);
});

test('monthly checkout prevents duplicate member-year plans before Stripe can charge', () => {
  const src = readFileSync(join(repoRoot, 'api', 'public', 'form-payment.js'), 'utf8');
  const monthly = src.slice(src.indexOf('async function handleCreateMonthlyCard'), src.indexOf('async function handleCreate('));
  const identityKey = monthly.indexOf('formMonthlyCardApplicantAgreementKey');
  const crossAttemptGuard = monthly.indexOf('MEMBERSHIP_PAYMENT_IN_PROGRESS');
  const memberYearClaim = monthly.indexOf('claimFormMonthlyCardMembership');
  const stripeCreate = monthly.indexOf('stripe.checkout.sessions.create');
  assert.ok(identityKey > -1, 'all form attempts for one applicant/year need one agreement key');
  assert.ok(crossAttemptGuard > identityKey, 'a second form attempt must be rejected against the shared agreement');
  assert.ok(memberYearClaim > -1 && memberYearClaim < stripeCreate,
    'a returning member year must be atomically reserved before Stripe Checkout');
  assert.match(monthly, /MEMBERSHIP_EMAIL_REQUIRED/, 'the pipeline identity must be stable before recurring checkout');
});

test('server confirm securely retrieves and replays a monthly-card checkout', () => {
  const src = readFileSync(join(repoRoot, 'api', 'public', 'form-payment.js'), 'utf8');
  const confirm = src.slice(src.indexOf('async function handleConfirm'));
  assert.match(confirm, /payment_provider === 'stripe_monthly_card'/);
  assert.match(confirm, /checkout\.sessions\.retrieve\(checkoutSessionId\)/);
  assert.match(confirm, /session\.status !== 'complete'/);
  assert.match(confirm, /processStripeCardPlanEvent/);
  assert.match(confirm, /outcome\.conflict/);
  assert.match(confirm, /MEMBERSHIP_YEAR_CONFLICT/);
});

test('completed monthly-card applications remain visible in Form Submissions', () => {
  const src = readFileSync(join(repoRoot, 'client', 'src', 'pages', 'FormSubmissions.jsx'), 'utf8');
  assert.match(src, /payment_provider === 'stripe_monthly_card'.*payment_status === 'setup_complete'/s);
  assert.match(src, /Monthly card set up/);
});
