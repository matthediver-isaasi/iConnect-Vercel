/**
 * Task #1112 — Regression smoke test for the confirm_payment hardening.
 *
 * Validates the following invariants directly against the source files
 * (no DB / no Stripe required, so this is safe to run in CI and from
 * this Replit workspace):
 *
 * 1. `api/public/membership-fees/[token].js` no longer flips the fee
 *    token to status='paid' BEFORE the history row is inserted.
 * 2. The same file handles `simResult.success === false` explicitly
 *    (auto-refund + 500 response).
 * 3. Accounting-provider failures in both that file AND
 *    `api/forms/membership-payment.js` persist `accounting_sync_status`
 *    + `accounting_sync_error` on the history row (not silently
 *    swallowed).
 * 4. The stuck-paid-token idempotency probe returns 409, not silent
 *    re-execution.
 * 5. The admin retry endpoint exists and rejects non-admin callers.
 *
 * Run:  node scripts/test-task1112-regression.mjs
 * Exits non-zero on failure.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

let failed = 0;
function assert(cond, msg) {
  if (cond) { console.log(`  ✓ ${msg}`); }
  else { console.error(`  ✗ ${msg}`); failed++; }
}

console.log('Task #1112 regression checks');

// ----- public/membership-fees/[token].js -----
const tokenFile = read('api/public/membership-fees/[token].js');

console.log('\n[public/membership-fees/[token].js]');

// (1) Token status MUST NOT be set to 'paid' in the same update that
// stamps the PI. The new sequence: stamp PI first (status still pending),
// then later flip to paid AFTER history insert succeeds.
const earlyPIStampMatch = tokenFile.match(/\.from\('membership_fee_token'\)\s*\n\s*\.update\(\{\s*\n\s*stripe_payment_intent_id: paymentIntentId,\s*\n\s*updated_at:[^}]+\}\)/);
assert(!!earlyPIStampMatch, 'PI is stamped onto the token without flipping status to paid');

const lateStatusPaid = tokenFile.match(/if \(recordCreated && feeToken\.status !== 'paid'\)/);
assert(!!lateStatusPaid, 'Token is flipped to paid only AFTER history insert (recordCreated check)');

// (2) Explicit simResult.success === false handling with auto-refund.
assert(
  /if \(!simResult\.success\)\s*\{[\s\S]{0,800}stripe\.refunds\.create/.test(tokenFile),
  'simResult.success=false triggers auto-refund'
);
assert(
  /membership_simulation_failed/.test(tokenFile),
  'auto-refund metadata identifies the simulation-failure cause'
);

// (3) Accounting failures persist on history row.
assert(
  /accounting_sync_status: 'failed'/.test(tokenFile),
  'accounting failure persists accounting_sync_status on the history row'
);
assert(
  /accounting_sync_error:/.test(tokenFile),
  'accounting failure persists accounting_sync_error on the history row'
);
assert(
  !/Xero invoice failed \(non-fatal\)/.test(tokenFile),
  'old "(non-fatal)" silent-swallow log line is removed'
);

// (4) Stuck-token idempotency probe.
assert(
  /STUCK TOKEN/.test(tokenFile) && /status\(409\)/.test(tokenFile),
  'stuck-paid-token state returns HTTP 409 (not silent re-execution)'
);

// (5) Token paid status check should NOT short-circuit confirm_payment.
assert(
  /feeToken\.status === 'paid' && action !== 'confirm_payment'/.test(tokenFile),
  'confirm_payment is exempt from the early "already paid" 400 short-circuit'
);

// ----- forms/membership-payment.js -----
const formsFile = read('api/forms/membership-payment.js');

console.log('\n[forms/membership-payment.js]');

assert(
  /accounting_sync_status: 'failed'/.test(formsFile),
  'accounting failure persists accounting_sync_status (forms mirror)'
);
assert(
  /accounting_sync_error:/.test(formsFile),
  'accounting failure persists accounting_sync_error (forms mirror)'
);
assert(
  !/Xero invoice failed \(non-fatal\)/.test(formsFile),
  'forms file also drops the (non-fatal) silent-swallow log line'
);
assert(
  /warning:[\s\S]{0,300}accounting invoice could not be generated/i.test(formsFile),
  'forms response surfaces warning to caller when accounting sync fails'
);

// ----- admin retry endpoint -----
const retryFile = read('api/admin/membership-invoice-retry.js');

console.log('\n[admin/membership-invoice-retry.js]');

assert(/hasAdminAccess/.test(retryFile), 'admin retry endpoint enforces RBAC');
assert(
  /buildInvoiceColumnUpdate/.test(retryFile),
  'admin retry endpoint persists invoice columns via buildInvoiceColumnUpdate'
);
assert(
  /accounting_sync_status: null/.test(retryFile) && /accounting_sync_error: null/.test(retryFile),
  'admin retry endpoint clears sync error on success'
);
assert(
  /reconcileMembershipInvoicePayment/.test(retryFile),
  'admin retry endpoint kicks payment reconciliation after success'
);

// ----- migration -----
const migration = read('supabase/migrations/20260528_membership_accounting_sync_status.sql');
console.log('\n[migration 20260528_membership_accounting_sync_status.sql]');
for (const tbl of ['organisation_membership_history', 'member_membership_history']) {
  assert(
    new RegExp(`ALTER TABLE ${tbl}[\\s\\S]{0,400}accounting_sync_status`).test(migration),
    `migration adds accounting_sync_status to ${tbl}`
  );
  assert(
    new RegExp(`ALTER TABLE ${tbl}[\\s\\S]{0,400}accounting_sync_error`).test(migration),
    `migration adds accounting_sync_error to ${tbl}`
  );
}
assert(/IF NOT EXISTS/.test(migration), 'migration uses IF NOT EXISTS (idempotent)');

console.log(`\nResult: ${failed === 0 ? 'PASS' : `FAIL (${failed} failures)`}`);
process.exit(failed === 0 ? 0 : 1);
