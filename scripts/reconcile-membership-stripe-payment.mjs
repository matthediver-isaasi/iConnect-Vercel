#!/usr/bin/env node
// Task #3278 — Admin-triggered reconcile for a succeeded Stripe membership
// PaymentIntent that was never recorded (client confirm_payment failed).
//
// Usage:
//   node scripts/reconcile-membership-stripe-payment.mjs <tenantId> <paymentIntentId> [--dry-run] [--base-url https://...]
//
// Runs against the PRODUCTION database (DEST_SUPABASE_URL/DEST_SUPABASE_KEY).
// Retrieves the PI with the tenant's own Stripe credentials (tolerating a
// test/live mode flip), then calls the shared idempotent recorder
// (recordSucceededMembershipPaymentIntent) — the same code path as the
// api/webhooks/stripe-membership.js webhook. Safe to re-run: dedupes by PI.

const [tenantId, paymentIntentId, ...rest] = process.argv.slice(2);
const dryRun = rest.includes('--dry-run');
const baseUrlIdx = rest.indexOf('--base-url');
const baseUrl = baseUrlIdx >= 0 ? rest[baseUrlIdx + 1] : '';

if (!tenantId || !paymentIntentId) {
  console.error('Usage: node scripts/reconcile-membership-stripe-payment.mjs <tenantId> <paymentIntentId> [--dry-run] [--base-url https://...]');
  process.exit(1);
}

// Point the app libs at the production (DEST) database.
if (process.env.DEST_SUPABASE_URL) process.env.SUPABASE_URL = process.env.DEST_SUPABASE_URL;
if (process.env.DEST_SUPABASE_KEY) process.env.SUPABASE_SERVICE_KEY = process.env.DEST_SUPABASE_KEY;

const { retrieveTenantPaymentIntent } = await import('../api/_lib/stripeCredentials.js');
const { recordSucceededMembershipPaymentIntent } = await import('../api/_lib/membershipPaymentReconciliation.js');

const retrieved = await retrieveTenantPaymentIntent(tenantId, 'membership', paymentIntentId);
if (!retrieved) {
  console.error('No Stripe credentials configured for tenant', tenantId);
  process.exit(1);
}
const { paymentIntent, usedMode } = retrieved;
console.log(`PI ${paymentIntent.id}: status=${paymentIntent.status} amount=${paymentIntent.amount} ${paymentIntent.currency} mode-key=${usedMode}`);
console.log('metadata:', JSON.stringify(paymentIntent.metadata));

if (paymentIntent.status !== 'succeeded') {
  console.error('PaymentIntent has not succeeded — nothing to reconcile.');
  process.exit(1);
}

if (dryRun) {
  console.log('[dry-run] Would call recordSucceededMembershipPaymentIntent — stopping here.');
  process.exit(0);
}

const outcome = await recordSucceededMembershipPaymentIntent({
  tenantId,
  paymentIntent,
  baseUrl,
  source: 'admin_reconcile_script',
});
console.log('Outcome:', JSON.stringify(outcome, null, 2));
process.exit(outcome.status === 'recorded' || outcome.status === 'already-recorded' ? 0 : 2);
