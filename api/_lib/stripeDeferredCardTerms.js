// Stripe 2025-11-17.clover: Checkout trial_end requires >=48 hours;
// billing_cycle_anchor supports shorter leads within one recurring interval.
// Save the exact request at consent so retries never move the first charge.
export function deferredCardTerms(simulation, acceptedAt) {
  const start = simulation?.paymentSchedule?.term_start_date;
  if (!start) return null;
  const first = Date.parse(`${start}T00:00:00.000Z`) / 1000;
  const accepted = Date.parse(acceptedAt) / 1000;
  if (!Number.isFinite(first) || !Number.isFinite(accepted)) throw new Error('Invalid card renewal dates');
  if (first <= accepted) return null;
  if (first - accepted > 730 * 86400) throw new Error('Card renewal start exceeds Stripe trial timing limit');
  // Leave a full day's Checkout lifetime above Stripe's 48-hour minimum.
  const subscriptionData = first - accepted > 3 * 86400
    ? { trial_end: first, trial_settings: { end_behavior: { missing_payment_method: 'cancel' } } }
    : { billing_cycle_anchor: first, proration_behavior: 'none' };
  return {
    version: 1, first_charge_at: first, first_charge_date: start,
    term_end_date: simulation.paymentSchedule.term_end_date,
    subscription_data: subscriptionData,
  };
}

export function deferredCardCheckoutOptions(snapshot) {
  const terms = snapshot?.deferred_billing;
  return terms ? {
    payment_method_collection: 'always',
    payment_method_types: ['card'],
    subscription_data: terms.subscription_data,
  } : {};
}

export function isZeroValueCardSetupInvoice(invoice) {
  return Number(invoice?.amount_paid) === 0
    && Number(invoice?.amount_due) === 0
    && Number(invoice?.total) === 0;
}
