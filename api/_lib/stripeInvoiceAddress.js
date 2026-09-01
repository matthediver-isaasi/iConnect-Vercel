const REQUIRED_ADDRESS_FIELDS = ['line1', 'city', 'postal_code', 'country'];

export class StripeBillingAddressError extends Error {
  constructor(message, code = 'STRIPE_BILLING_ADDRESS_REQUIRED') {
    super(message);
    this.name = 'StripeBillingAddressError';
    this.code = code;
    this.retryable = true;
  }
}

function clean(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Validate Stripe's structured address and produce an immutable, provider-ready
 * snapshot. City/state share a line so Xero's five-line parser retains both.
 */
export function normalizeStripeBillingAddress(address) {
  const normalized = {
    line1: clean(address?.line1),
    line2: clean(address?.line2),
    city: clean(address?.city),
    state: clean(address?.state),
    postal_code: clean(address?.postal_code),
    country: clean(address?.country)?.toUpperCase() || null,
  };
  const missing = REQUIRED_ADDRESS_FIELDS.filter((field) => !normalized[field]);
  if (missing.length) {
    throw new StripeBillingAddressError(
      `Stripe billing address is incomplete (missing ${missing.join(', ')})`,
    );
  }
  const cityRegion = [normalized.city, normalized.state].filter(Boolean).join(', ');
  return {
    ...normalized,
    formatted: [
      normalized.line1,
      normalized.line2,
      cityRegion,
      normalized.postal_code,
      normalized.country,
    ].filter(Boolean).join('\n'),
  };
}

export function stripeInvoiceAddressFromSnapshot(snapshot) {
  if (!snapshot) {
    throw new StripeBillingAddressError('Stripe billing address snapshot is missing');
  }
  return normalizeStripeBillingAddress(snapshot).formatted;
}

function objectId(value) {
  return typeof value === 'string' ? value : value?.id || null;
}

export async function capturePaymentIntentBillingAddress({ stripe, paymentIntent }) {
  if (!stripe || !paymentIntent) {
    throw new StripeBillingAddressError('Stripe payment details are unavailable');
  }
  let snapshot = null;
  const saved = paymentIntent.metadata?.invoice_address_snapshot;
  if (saved) {
    try {
      snapshot = normalizeStripeBillingAddress(JSON.parse(saved));
    } catch {
      throw new StripeBillingAddressError('Saved Stripe billing address snapshot is unreadable');
    }
  }
  if (!snapshot) {
    let paymentMethod = paymentIntent.payment_method;
    if (typeof paymentMethod === 'string') {
      paymentMethod = await stripe.paymentMethods.retrieve(paymentMethod);
    }
    snapshot = normalizeStripeBillingAddress(paymentMethod?.billing_details?.address);
    if (!paymentIntent.id) {
      throw new StripeBillingAddressError('Stripe PaymentIntent identifier is missing');
    }
    await stripe.paymentIntents.update(paymentIntent.id, {
      metadata: {
        invoice_address_snapshot: JSON.stringify(snapshot),
      },
    });
  }
  const customerId = objectId(paymentIntent.customer);
  if (!customerId) {
    throw new StripeBillingAddressError('Stripe membership payment has no reusable Customer');
  }
  await stripe.customers.update(customerId, { address: {
    line1: snapshot.line1,
    line2: snapshot.line2 || undefined,
    city: snapshot.city,
    state: snapshot.state || undefined,
    postal_code: snapshot.postal_code,
    country: snapshot.country,
  } });
  return snapshot;
}

export async function captureCheckoutBillingAddress({ stripe, session }) {
  if (!stripe || !session) {
    throw new StripeBillingAddressError('Stripe Checkout billing details are unavailable');
  }
  const snapshot = normalizeStripeBillingAddress(session.customer_details?.address);
  const customerId = objectId(session.customer);
  if (!customerId) {
    throw new StripeBillingAddressError('Stripe membership Checkout has no reusable Customer');
  }
  await stripe.customers.update(customerId, { address: {
    line1: snapshot.line1,
    line2: snapshot.line2 || undefined,
    city: snapshot.city,
    state: snapshot.state || undefined,
    postal_code: snapshot.postal_code,
    country: snapshot.country,
  } });
  return snapshot;
}

export async function recoverPaymentIntentInvoiceAddress({ stripe, paymentIntent }) {
  return stripeInvoiceAddressFromSnapshot(
    await capturePaymentIntentBillingAddress({ stripe, paymentIntent }),
  );
}