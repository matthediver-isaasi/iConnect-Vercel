/**
 * GoCardless sandbox proof script (Phase 1).
 *
 * Exercises the contained service module end-to-end against the GoCardless
 * SANDBOX: creates a Billing Request (mandate only), a hosted Billing
 * Request Flow, prints the authorisation URL, and demonstrates that the
 * deterministic idempotency key prevents duplicate creation.
 *
 * Read-only against the platform DB — creates nothing locally.
 *
 * Usage:
 *   GOCARDLESS_ENVIRONMENT=sandbox GOCARDLESS_ACCESS_TOKEN=sandbox_... \
 *     node scripts/gocardless-sandbox-proof.mjs
 */

import {
  getGocardlessEnvironment,
  isGocardlessConfigured,
  buildIdempotencyKey,
  createBillingRequest,
  getBillingRequest,
  createBillingRequestFlow,
  verifyWebhookSignature,
} from '../api/_lib/gocardless.js';
import crypto from 'node:crypto';

if (!isGocardlessConfigured()) {
  console.error('GOCARDLESS_ACCESS_TOKEN is not set — cannot run the sandbox proof.');
  console.error('Set GOCARDLESS_ACCESS_TOKEN (sandbox token) and re-run.');
  process.exit(1);
}
if (getGocardlessEnvironment() !== 'sandbox') {
  console.error('Refusing to run the proof against the LIVE environment. Set GOCARDLESS_ENVIRONMENT=sandbox.');
  process.exit(1);
}

const runId = process.argv[2] || `proof-${new Date().toISOString().slice(0, 10)}`;

async function main() {
  console.log(`GoCardless sandbox proof (runId=${runId})`);

  // 1. Deterministic idempotency: same runId -> same key -> same billing request.
  const idempotencyKey = buildIdempotencyKey('proof-billing-request', runId);
  console.log(`Idempotency key: ${idempotencyKey.slice(0, 16)}…`);

  const br1 = await createBillingRequest({
    idempotencyKey,
    metadata: { proof_run: runId },
  });
  console.log(`Billing request: ${br1.id} (status=${br1.status})`);

  const br2 = await createBillingRequest({
    idempotencyKey,
    metadata: { proof_run: runId },
  });
  if (br2.id === br1.id) {
    console.log(`Idempotency verified: retried create returned the SAME billing request (${br2.id}).`);
  } else {
    console.error(`IDEMPOTENCY FAILURE: got a different billing request ${br2.id} vs ${br1.id}`);
    process.exit(1);
  }

  // 2. Hosted flow.
  const flow = await createBillingRequestFlow({
    billingRequestId: br1.id,
    redirectUri: 'https://dev.iconn.app/membership/direct-debit/complete',
    exitUri: 'https://dev.iconn.app/membership/direct-debit/cancelled',
  });
  console.log(`Billing request flow: ${flow.id}`);
  console.log(`Authorisation URL (open to complete the sandbox mandate):\n  ${flow.authorisation_url}`);

  // 3. Re-fetch round trip.
  const fetched = await getBillingRequest(br1.id);
  console.log(`Re-fetched billing request status: ${fetched.status}`);

  // 4. Webhook signature self-check with an ad-hoc secret.
  const secret = 'proof-secret';
  const payload = JSON.stringify({ events: [{ id: 'EVTESTPROOF', resource_type: 'billing_requests', action: 'created', links: { billing_request: br1.id } }] });
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  const ok = verifyWebhookSignature(payload, sig, secret);
  const bad = verifyWebhookSignature(payload, sig.replace(/^./, sig[0] === 'a' ? 'b' : 'a'), secret);
  console.log(`Webhook signature verification: valid=${ok} tampered-rejected=${!bad}`);
  if (!ok || bad) process.exit(1);

  console.log('\nSandbox proof PASSED.');
}

main().catch((err) => {
  console.error('Sandbox proof failed:', err.message);
  process.exit(1);
});
