import { retrieveTenantPaymentIntent } from './stripeCredentials.js';

// The caller must resolve the submission using the original unguessable
// checkout key, scoped to the tenant and form. Never accept a browser's
// claim that an unpaid/abandoned payment is safe to release.
export async function cancelCartPayment(db, row, retrieveStripe = retrieveTenantPaymentIntent, { resumeShopping = false } = {}) {
  const releasedResult = async () => {
    if (resumeShopping && row.submission_data?.__cart_reservation) {
      const resumed = await db.rpc('resume_form_cart_shopping', {
        p_tenant_id: row.tenant_id, p_submission_id: row.id,
      });
      if (resumed.error) throw new Error('Payment was cancelled, but your cart could not yet be reopened. Please retry.');
    }
    return { released: true };
  };
  if (row.payment_provider !== 'stripe' || row.payment_status === 'paid'
    || row.payment_meta?.membership || row.payment_meta?.monthly_card) {
    throw new Error('This order cannot be cancelled here. If you have paid, do not pay again.');
  }
  const { data: receipt, error } = await db.from('form_cart_receipt').select('state')
    .eq('tenant_id', row.tenant_id).eq('submission_id', row.id).maybeSingle();
  if (error) throw new Error('We could not check your cart. Please retry.');
  if (!receipt || !['held', 'released'].includes(receipt.state)) {
    throw new Error('This order is already confirmed or cannot be safely changed.');
  }
  if (receipt.state === 'released') return releasedResult();
  if (!row.payment_reference) throw new Error('Payment setup is still being checked. Please retry shortly.');
  const found = await retrieveStripe(row.tenant_id, row.payment_meta?.stripe_feature || 'forms',
    row.payment_reference, { timeoutMs: 10000 });
  let pi = found?.paymentIntent;
  if (!pi || pi.id !== row.payment_reference || pi.metadata?.form_submission_id !== row.id
    || pi.metadata?.tenant_id !== row.tenant_id || pi.metadata?.form_id !== row.form_id) {
    throw new Error('We could not verify this payment. Your cart has been kept; please retry.');
  }
  if (['requires_payment_method', 'requires_confirmation', 'requires_action'].includes(pi.status)) {
    pi = await found.stripe.paymentIntents.cancel(pi.id, {}, { timeout: 10000 });
  }
  if (pi.status !== 'canceled' || pi.id !== row.payment_reference) {
    throw new Error('Payment is complete or still processing. Return to payment to check its status; do not pay again.');
  }
  const released = await db.rpc('finalize_form_cart', {
    p_tenant_id: row.tenant_id, p_submission_id: row.id, p_state: 'released',
    p_release_evidence: { provider: 'stripe', reference: pi.id,
      terminal_status: 'cancelled', verified_at: new Date().toISOString() },
  });
  if (released.error) throw new Error('Payment was cancelled, but your cart could not yet be released. Please retry.');
  return releasedResult();
}
