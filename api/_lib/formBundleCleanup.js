import { retrieveTenantPaymentIntent } from './stripeCredentials.js';
import { gocardlessForTenant } from './gocardless.js';
import { validateGocardlessProviderContext } from './gocardlessFormProviderContext.js';
import { formCartReady } from './formCart.js';

// Called by the durable payment reconciliation cron. The age threshold only
// permits requesting cancellation; it never itself releases a reservation.
export async function cleanupFormBundleHolds(db, {
  limit = 10, deadlineAt = Date.now() + 10000,
  retrieveStripe = retrieveTenantPaymentIntent, getGc = gocardlessForTenant,
  cart = false,
} = {}) {
  if (cart && !await formCartReady(db)) return { checked: 0, released: 0, unresolved: 0 };
  const finalize = cart ? 'finalize_form_cart' : 'finalize_form_bundle';
  const result = { checked: 0, released: 0, unresolved: 0 };
  const { data: holds, error } = await db.from(cart ? 'form_cart_receipt' : 'form_bundle_allocation')
    .select('tenant_id,submission_id').eq('state', 'held')
    .lte('next_check_at', new Date().toISOString()).order('next_check_at').order('id').limit(limit);
  if (error) throw error;
  for (const hold of holds || []) {
    if (Date.now() >= deadlineAt - 2000) break;
    if (cart) {
      // Recheck under a database lock: activity may have renewed the hold
      // since the candidate list was read. Once claimed, activity cannot revive it.
      const claim = await db.rpc('claim_form_cart_cleanup', {
        p_tenant_id: hold.tenant_id, p_submission_id: hold.submission_id,
      });
      // Compatible rollout: retain the old timeout until the migration lands.
      if (claim.error && !['42883', 'PGRST202'].includes(claim.error.code)) throw claim.error;
      if (!claim.error && claim.data !== true) continue;
    }
    result.checked++;
    let diagnostic = 'Provider outcome remains unresolved; stock remains held.';
    try {
      const { data: row, error: rowError } = await db.from('form_submission').select('*')
        .eq('tenant_id', hold.tenant_id).eq('id', hold.submission_id).single();
      if (rowError) throw rowError;
      if (row.payment_status === 'paid') {
        const done = await db.rpc(finalize, { p_tenant_id: row.tenant_id,
          p_submission_id: row.id, p_state: 'consumed' });
        if (done.error) throw done.error;
        continue;
      }
      let cancelled = false;
      if (!row.payment_reference) {
        diagnostic = 'Provider reference was not recorded. Administrator review required; do not retry or release blindly.';
      } else if (row.payment_provider === 'stripe') {
        const found = await retrieveStripe(row.tenant_id, row.payment_meta?.stripe_feature || 'forms',
          row.payment_reference, { timeoutMs: 3000 });
        let pi = found?.paymentIntent;
        if (!pi || pi.id !== row.payment_reference || pi.metadata?.form_submission_id !== row.id
          || pi.metadata?.tenant_id !== row.tenant_id || pi.metadata?.form_id !== row.form_id) {
          throw new Error('Provider identity mismatch');
        }
        if (['requires_payment_method','requires_confirmation','requires_action'].includes(pi.status)) {
          pi = await found.stripe.paymentIntents.cancel(pi.id, {}, { timeout: 3000 });
        }
        cancelled = pi.status === 'canceled';
        if (pi.status === 'succeeded') diagnostic = 'Payment succeeded; awaiting authoritative payment reconciliation.';
      } else if (row.payment_provider === 'gocardless') {
        const gc = await getGc(row.tenant_id);
        if (validateGocardlessProviderContext(row.payment_meta?.gc_provider_context, gc.providerContext)) {
          throw new Error('Provider account could not be verified');
        }
        let br = await gc.getBillingRequest(row.payment_reference, { timeoutMs: 3000 });
        if (br.id !== row.payment_reference) throw new Error('Provider identity mismatch');
        // Never cancel/release a billing request which has created a payment.
        if (!br.links?.payment_request_payment && !br.links?.payment
          && !['fulfilled','cancelled','failed'].includes(br.status)) {
          br = await gc.cancelBillingRequest(br.id);
        }
        cancelled = br.status === 'cancelled'
          && !br.links?.payment_request_payment && !br.links?.payment;
      }
      if (cancelled) {
        const released = await db.rpc(finalize, { p_tenant_id: row.tenant_id,
          p_submission_id: row.id, p_state: 'released', p_release_evidence: {
            provider: row.payment_provider, reference: row.payment_reference,
            terminal_status: 'cancelled', verified_at: new Date().toISOString(),
          } });
        if (released.error) throw released.error;
        result.released++;
        continue;
      }
    } catch {
      diagnostic = 'Provider verification or finalization failed. Stock remains held; administrator review may be required.';
    }
    result.unresolved++;
    const deferred = await db.rpc(cart ? 'defer_form_cart_check' : 'defer_form_bundle_check', {
      p_tenant_id: hold.tenant_id, p_submission_id: hold.submission_id, p_error: diagnostic,
    });
    if (deferred.error) throw deferred.error;
  }
  return result;
}
