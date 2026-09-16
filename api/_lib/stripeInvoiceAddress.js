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

const CANONICAL_ADDRESS_KEY = 'stripe_billing_address';
const LEGACY_ADDRESS_KEY = 'billing_address';

function hasOwn(value, key) {
  return !!value && Object.prototype.hasOwnProperty.call(value, key);
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

/**
 * Resolve the immutable Stripe address stored on a membership agreement.
 *
 * New monthly Checkout completions store the snapshot at
 * metadata.stripe_billing_address. Older agreements stored it under
 * metadata.card.billing_address. The canonical key is authoritative when it
 * is present: an unreadable canonical value must not silently fall back to a
 * legacy value, because that could invoice from a different snapshot.
 */
export function stripeBillingAddressSnapshotFromMetadata(metadata) {
  if (hasOwn(metadata, CANONICAL_ADDRESS_KEY)) {
    return normalizeStripeBillingAddress(metadata[CANONICAL_ADDRESS_KEY]);
  }
  if (hasOwn(metadata?.card, LEGACY_ADDRESS_KEY)) {
    return normalizeStripeBillingAddress(metadata.card[LEGACY_ADDRESS_KEY]);
  }
  throw new StripeBillingAddressError('Stripe billing address snapshot is missing');
}

/** True when either the canonical or supported legacy snapshot is present. */
export function hasStripeBillingAddressSnapshot(metadata) {
  return hasOwn(metadata, CANONICAL_ADDRESS_KEY)
    || hasOwn(metadata?.card, LEGACY_ADDRESS_KEY);
}

/** Resolve an agreement metadata object to the provider-ready invoice text. */
export function stripeInvoiceAddressFromMetadata(metadata) {
  return stripeBillingAddressSnapshotFromMetadata(metadata).formatted;
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

export async function capturePaymentIntentBillingAddress({
  stripe,
  paymentIntent,
  requireCustomer = true,
}) {
  if (!stripe || !paymentIntent) {
    throw new StripeBillingAddressError('Stripe payment details are unavailable');
  }
  // A PaymentMethod and PaymentIntent metadata are mutable after collection.
  // The charge's billing_details are the evidence captured at money movement;
  // never invoice from a later customer/profile/PaymentMethod edit.
  const chargeId = objectId(paymentIntent.latest_charge);
  if (!chargeId) {
    throw new StripeBillingAddressError('The successful Stripe charge is unavailable for address capture');
  }
  let charge;
  try {
    charge = await stripe.charges.retrieve(chargeId);
  } catch {
    throw new StripeBillingAddressError('The successful Stripe charge could not be retrieved for address capture');
  }
  const snapshot = normalizeStripeBillingAddress(charge?.billing_details?.address);
  const customerId = objectId(paymentIntent.customer);
  if (!customerId) {
    if (requireCustomer) {
      throw new StripeBillingAddressError('Stripe membership payment has no reusable Customer');
    }
    return snapshot;
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