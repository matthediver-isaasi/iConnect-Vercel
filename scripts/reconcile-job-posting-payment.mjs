#!/usr/bin/env node
// Task #2995 — One-off repair for a job posting stuck in `pending_payment`
// whose Stripe charge succeeded (Jennie Colbourne's Hartpury posting).
//
// Runs the SAME shared reconciliation the hourly cron uses
// (api/_lib/jobPostingPaymentReconciliation.js): verifies the PaymentIntent
// is `succeeded` and belongs to this posting, then flips it to
// payment_status='paid' / status='pending_approval' via an idempotent
// compare-and-set claim, backfilling tenant_id if missing and firing the
// poster/admin notification emails.
//
// Usage:
//   node scripts/reconcile-job-posting-payment.mjs             # dry run (default)
//   node scripts/reconcile-job-posting-payment.mjs --apply     # perform the update + emails
//   node scripts/reconcile-job-posting-payment.mjs --apply --no-email   # update only
//   node scripts/reconcile-job-posting-payment.mjs --id=<uuid> # target a different posting
//
// Pinned by default to posting 571a0a58-2645-4174-bd1c-473cd3f302bc.
// Idempotent: a second --apply run reports "already-pending_approval".

const DEFAULT_POSTING_ID = '571a0a58-2645-4174-bd1c-473cd3f302bc';

// Point the shared api/_lib stack (database.js, stripeCredentials, emailService)
// at the destination (prod) Supabase before importing it.
process.env.SUPABASE_URL = process.env.DEST_SUPABASE_URL || process.env.SUPABASE_URL;
process.env.SUPABASE_SERVICE_KEY = process.env.DEST_SUPABASE_KEY || process.env.SUPABASE_SERVICE_KEY;

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const NO_EMAIL = args.includes('--no-email');
const idArg = args.find((a) => a.startsWith('--id='));
const POSTING_ID = idArg ? idArg.split('=')[1] : DEFAULT_POSTING_ID;

const { supabase } = await import('../api/_lib/database.js');
const { reconcileJobPostingRow } = await import('../api/_lib/jobPostingPaymentReconciliation.js');

if (!supabase) {
  console.error('Supabase not configured (need DEST_SUPABASE_URL / DEST_SUPABASE_KEY).');
  process.exit(1);
}

const { data: row, error } = await supabase
  .from('job_posting')
  .select('*')
  .eq('id', POSTING_ID)
  .maybeSingle();

if (error) {
  console.error('Failed to load posting:', error.message);
  process.exit(1);
}
if (!row) {
  console.error(`Job posting ${POSTING_ID} not found.`);
  process.exit(1);
}

console.log('Posting:', {
  id: row.id,
  title: row.title,
  company: row.company_name,
  contact: `${row.contact_name} <${row.contact_email}>`,
  status: row.status,
  payment_status: row.payment_status,
  stripe_payment_intent_id: row.stripe_payment_intent_id,
  tenant_id: row.tenant_id,
  amount_paid: row.amount_paid,
  created_date: row.created_date,
  closing_date: row.closing_date,
});

if (row.status !== 'pending_payment') {
  console.log(`Nothing to do — posting is already '${row.status}' (payment_status='${row.payment_status}').`);
  process.exit(0);
}

if (!APPLY) {
  console.log('\nDRY RUN — would run reconciliation (verify Stripe PaymentIntent succeeded,');
  console.log('then flip to pending_approval/paid and send poster+admin emails).');
  console.log('Re-run with --apply to perform the update.');
  process.exit(0);
}

console.log(`\nApplying reconciliation${NO_EMAIL ? ' (emails suppressed)' : ''}...`);
const outcome = await reconcileJobPostingRow({ row, sendEmails: !NO_EMAIL });
console.log('Outcome:', outcome);

if (outcome.transitioned) {
  const { data: after } = await supabase
    .from('job_posting')
    .select('id, status, payment_status, payment_date, tenant_id')
    .eq('id', POSTING_ID)
    .maybeSingle();
  console.log('Posting after update:', after);
} else {
  console.log(`Not transitioned (reason: ${outcome.skippedReason}).`);
}
