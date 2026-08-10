// Source-contract tests for the membership retry sweep (Task #3489):
// paid submissions with unfinished membership work must be retried
// eventually regardless of age, oldest-first, including orphaned
// (stale-claimed) workflow dispatch claims.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const reconSrc = fs.readFileSync(new URL('./formPaymentReconciliation.js', import.meta.url), 'utf8');
const finalizeSrc = fs.readFileSync(new URL('./formMembershipFinalize.js', import.meta.url), 'utf8');

const sweepAt = reconSrc.indexOf('Third sweep (Task #3489)');
assert.ok(sweepAt > -1, 'membership sweep block must exist');
const sweep = reconSrc.slice(sweepAt, reconSrc.indexOf('return results', sweepAt));

test('membership sweep has no lookback bound (old unfinished work is still retried)', () => {
  assert.ok(!/gte\('created_date'/.test(sweep),
    'membership sweep must not be bounded by the payment reconciliation lookback');
});

test('membership sweep serves oldest-first with a deterministic tiebreak', () => {
  assert.match(sweep, /\.order\('created_date', \{ ascending: true \}\)/);
  assert.match(sweep, /\.order\('id', \{ ascending: true \}\)/);
  const orderAt = sweep.indexOf(".order('created_date'");
  const limitAt = sweep.indexOf('.limit(');
  assert.ok(orderAt > -1 && orderAt < limitAt, 'ordering must be applied before the limit');
});

test('membership sweep selects missing stamps, pending side effects, and stale claims', () => {
  assert.match(sweep, /payment_meta->membership_result\.is\.null/);
  assert.match(sweep, /invoice_state\.eq\.pending/);
  assert.match(sweep, /workflow_state\.eq\.pending/);
  assert.match(sweep, /workflow_state\.eq\.claimed/);
  assert.match(sweep, /workflow_claimed_at\.lt\./);
  // Stale threshold derives from the shared TTL constant.
  assert.match(sweep, /WORKFLOW_CLAIM_TTL_MS/);
  assert.match(reconSrc, /import \{ finalizeFormMembership, WORKFLOW_CLAIM_TTL_MS \} from '\.\/formMembershipFinalize\.js'/);
});

test('workflow dispatch is claim-before-fire with CAS filters', () => {
  const claimAt = finalizeSrc.indexOf('const claimWorkflow');
  assert.ok(claimAt > -1);
  const claim = finalizeSrc.slice(claimAt, finalizeSrc.indexOf('// ── Side-effect runner', claimAt));
  // CAS: conditional update filtered on the current state, verified via
  // affected rows.
  assert.match(claim, /\.filter\('payment_meta->membership_result->>workflow_state', 'eq', expectedState\)/);
  assert.match(claim, /workflow_claimed_at', 'eq', expectedClaimedAt/);
  assert.match(claim, /\.select\('id'\)/);
  // Fire only after a successful claim; stamp 'done' after dispatch; a
  // known-failed dispatch releases the claim.
  const wfAt = finalizeSrc.indexOf('if (claim.claimed)');
  assert.ok(wfAt > -1);
  const wf = finalizeSrc.slice(wfAt, wfAt + 1600);
  assert.ok(wf.indexOf('fireWorkflowForPaidRow') < wf.indexOf("workflow_state: 'done'"));
  assert.match(wf, /workflow_state: 'pending', workflow_claimed_at: null/);
});

test('resume path treats claimed workflow state as incomplete', () => {
  assert.match(finalizeSrc, /prior\.workflow_state === 'pending' \|\| prior\.workflow_state === 'claimed'/);
});

test('sweep retries unresolved-entity submissions indefinitely, re-running the pipeline', () => {
  assert.match(sweep, /status\.eq\.awaiting_entity/);
  assert.match(finalizeSrc, /status: 'awaiting_entity', attempts/);
  // Escalation note after MAX_ENTITY_ATTEMPTS, but NO terminal 'no_entity'
  // stamp — a paid row must never be abandoned.
  assert.match(finalizeSrc, /attempts === MAX_ENTITY_ATTEMPTS/);
  assert.ok(!finalizeSrc.includes("status: 'no_entity'"), 'paid rows must never be terminally abandoned');
  // The sweep re-runs the form's entity pipelines (shared runner, same as
  // the payment finalizer) before each membership retry when the target
  // entity is missing.
  assert.match(sweep, /runFormEntityPipelines\(\{ supabase, submission: row, form, baseUrl \}\)/);
  assert.match(reconSrc, /import \{ runFormEntityPipelines \} from '\.\/formEntityPipelines\.js'/);
  const finPaySrc = fs.readFileSync(new URL('./formPaymentFinalize.js', import.meta.url), 'utf8');
  assert.match(finPaySrc, /runFormEntityPipelines\(\{ supabase, submission, form, baseUrl \}\)/);
  // Entity ids are re-read fresh from the submission row before concluding
  // the entity is missing (caller snapshots can be stale).
  assert.match(finalizeSrc, /select\('created_member_id, organization_id'\)/);
});

const paymentSrc = fs.readFileSync(new URL('../public/form-payment.js', import.meta.url), 'utf8');

test('payment-create validates scope-to-pipeline BEFORE any charge exists', () => {
  const blockAt = paymentSrc.indexOf('Scope-to-pipeline validation');
  assert.ok(blockAt > -1, 'scope validation block must exist');
  // Member-scoped structures require a member pipeline; organisation-scoped
  // require an organisation pipeline or an organisation prefill.
  assert.match(paymentSrc, /membershipTarget === 'member' && !hasMemberPipeline/);
  assert.match(paymentSrc, /membershipTarget === 'organization' && !hasOrgPipeline && !prefill_organization_id/);
  assert.ok(paymentSrc.includes("code: 'MEMBERSHIP_TARGET_UNRESOLVABLE'"));
  // Validation happens before the pending submission / provider intent is
  // created.
  assert.ok(blockAt < paymentSrc.indexOf('stripe.paymentIntents.create'), 'scope validation must precede payment creation');
  assert.ok(blockAt < paymentSrc.indexOf("payment_status: 'pending'"), 'scope validation must precede the pending submission row');
});

test('finalizer still passes submission values to the email sender after pipeline extraction', () => {
  const finPaySrc = fs.readFileSync(new URL('./formPaymentFinalize.js', import.meta.url), 'utf8');
  const declAt = finPaySrc.indexOf("const submissionData = submission.submission_data || {}");
  assert.ok(declAt > -1, 'submissionData must be declared in finalizeFormSubmission');
  const fnAt = finPaySrc.indexOf('export async function finalizeFormSubmission');
  const emailAt = finPaySrc.indexOf('sendSubmissionEmailsGuarded', fnAt);
  assert.ok(fnAt > -1 && emailAt > declAt && declAt > fnAt,
    'submissionData must be declared inside the finalizer before the email send');
});

test('pending rows with a provider payment reference are immutable on same-key retries', () => {
  const guardAt = paymentSrc.indexOf('if (existing.payment_reference)');
  assert.ok(guardAt > -1, 'payment-reference immutability guard must exist');
  const guard = paymentSrc.slice(guardAt, paymentSrc.indexOf('} else {', guardAt));
  // Fingerprint compares charge amount, currency, provider, and the
  // membership quote (config + total) before reuse.
  assert.match(guard, /Number\(existing\.payment_amount\) === Number\(amount\)/);
  assert.match(guard, /payment_currency/);
  assert.match(guard, /existing\.payment_provider === provider/);
  assert.match(guard, /config_id/);
  assert.match(guard, /total_with_vat/);
  assert.ok(guard.includes("code: 'PAYMENT_ALREADY_INITIATED'"), 'mismatched retries must 409');
  // The guard must run BEFORE the refresh update mutates the row.
  assert.ok(guardAt < paymentSrc.indexOf('submission_data: values,', guardAt - 2000) || guardAt < paymentSrc.indexOf('const { data: refreshed'), 'guard precedes the refresh path');
  // Refresh (mutation) only happens on the else branch (no reference yet).
  const refreshAt = paymentSrc.indexOf('const { data: refreshed');
  assert.ok(refreshAt > guardAt, 'refresh path must be gated behind the no-reference branch');
});

test('Stripe same-key retries reuse the existing intent; at most one payable intent per submission', () => {
  const reuseAt = paymentSrc.indexOf("submissionRow.payment_reference && submissionRow.payment_provider === 'stripe'");
  assert.ok(reuseAt > -1, 'stripe intent-reuse guard must exist');
  const createAt = paymentSrc.indexOf('stripe.paymentIntents.create');
  assert.ok(reuseAt < createAt, 'reuse guard must run before any new intent is created');
  const guard = paymentSrc.slice(reuseAt, createAt);
  // A still-payable intent with the same amount/currency is returned as-is.
  assert.match(guard, /paymentIntents\.retrieve/);
  assert.match(guard, /existingIntent\.amount === amountMinor/);
  assert.match(guard, /clientSecret: existingIntent\.client_secret/);
  // A superseded intent is cancelled BEFORE a replacement is created; if
  // cancellation fails the request aborts rather than leaving two payable
  // intents.
  assert.match(guard, /paymentIntents\.cancel\(existingIntent\.id\)/);
  assert.ok(guard.includes("code: 'PAYMENT_ALREADY_INITIATED'"), 'failed cancel must abort, not replace');
  // An already-succeeded intent short-circuits instead of re-charging.
  assert.match(guard, /status === 'succeeded'/);
});

test('Stripe intent publication is a CAS — concurrent racers cancel their losing intent', () => {
  const createAt = paymentSrc.indexOf('stripe.paymentIntents.create');
  const publish = paymentSrc.slice(createAt, paymentSrc.indexOf('// GoCardless'));
  // The reference update is conditional on the reference we started from
  // (null for a fresh row, the superseded id after a cancel), verified via
  // the affected row.
  assert.match(publish, /\.eq\('payment_reference', priorStripeReference\)/);
  assert.match(publish, /\.is\('payment_reference', null\)/);
  assert.match(publish, /claimQuery\.select\('id'\)\.maybeSingle\(\)/);
  // The CAS loser cancels ITS OWN intent before responding, then returns
  // the winner's intent (or 409) — never leaves two payable intents.
  const loserAt = publish.indexOf('claimError || !claimedRow');
  assert.ok(loserAt > -1);
  const loser = publish.slice(loserAt);
  assert.match(loser, /paymentIntents\.cancel\(paymentIntent\.id\)/);
  assert.match(loser, /paymentIntents\.retrieve\(winnerRow\.payment_reference\)/);
  assert.ok(loser.includes("code: 'PAYMENT_ALREADY_INITIATED'"));
});

test('member-scoped quotes evaluate discounts against member fields, not organisation fields', () => {
  const quoteSrc = fs.readFileSync(new URL('./membershipQuote.js', import.meta.url), 'utf8');
  // The quote passes the config's scope into the discount evaluation.
  assert.match(quoteSrc, /evaluateDiscountsForEntity\(config\.id, tenantId, NIL_UUID, fieldOverrides, target\)/);
  const discountSrc = fs.readFileSync(new URL('./discountHelper.js', import.meta.url), 'utf8');
  // The helper branches BOTH the table and the key column by scope, and
  // form-answer overrides bypass the DB lookup entirely.
  assert.match(discountSrc, /isMemberScope \? 'member_preference_value' : 'organization_preference_value'/);
  assert.match(discountSrc, /isMemberScope \? 'member_id' : 'organization_id'/);
  assert.match(discountSrc, /const dbFieldIds = fieldIds\.filter\(id => !\(id in valueMap\)\)/);
});

test('payment-create only accepts membership configs effective today', () => {
  // Persisted form rules can outlive their structure: the endpoint must
  // resolve the config through the lifecycle-aware active-configs query
  // (effective_from/effective_to window), never a bare by-id lookup.
  assert.match(paymentSrc, /getAllActiveConfigs.*membershipConfigResolver/s);
  assert.match(paymentSrc, /activeConfigs \|\| \[\]\)\.find\(c => c\.id === membershipAction\.configId\)/);
  assert.ok(!/getConfigByIdDirect/.test(paymentSrc), 'payment-create must not use the lifecycle-unaware by-id lookup');
  // The resolver enforces the effective window on both ends.
  const resolverSrc = fs.readFileSync(new URL('./membershipConfigResolver.js', import.meta.url), 'utf8');
  const activeFnAt = resolverSrc.indexOf('export async function getAllActiveConfigs');
  const activeFn = resolverSrc.slice(activeFnAt, activeFnAt + 800);
  assert.match(activeFn, /effective_from\.is\.null,effective_from\.lte\./);
  assert.match(activeFn, /effective_to\.is\.null,effective_to\.gte\./);
});

test('member-scoped structures quote detached even with an organisation prefill', () => {
  // Only organisation-target actions use the org simulation branch.
  assert.match(paymentSrc, /membershipTarget === 'organization' && prefill_organization_id/);
});
