// Collection authority is independent of the membership term and of arrears.
// Never pass a live structure to resolveSavedCollectionPolicy: only consent
// evidence can authorise continuation or variable prices.
const ends = ['stop', 'continue'];
const prices = ['fixed', 'dynamic'];

function explicitPolicy(value) {
  if (value?.version === 1 && ends.includes(value.end_policy) && prices.includes(value.pricing_policy)) {
    return { version: 1, end_policy: value.end_policy, pricing_policy: value.pricing_policy };
  }
  return null;
}

export function resolveStructureCollectionPolicy(config = {}) {
  const configured = config.dd_policy_version != null
    || config.dd_collection_end_policy != null || config.dd_pricing_policy != null;
  if (configured) {
    const policy = explicitPolicy({
      version: config.dd_policy_version,
      end_policy: config.dd_collection_end_policy,
      pricing_policy: config.dd_pricing_policy,
    });
    if (!policy) throw new Error('Choose both Direct Debit collection policies before saving or collecting payment.');
    if (policy.pricing_policy === 'dynamic' && config.dd_invoicing_mode !== 'per_instalment') {
      throw new Error('Dynamic Direct Debit prices require per-instalment invoicing.');
    }
    return policy;
  }
  // Compatibility for an explicitly configured legacy structure, not an
  // inferred default and never permission for dynamic pricing.
  if (typeof config.dd_auto_renew === 'boolean') {
    return { version: 1, end_policy: config.dd_auto_renew ? 'continue' : 'stop', pricing_policy: 'fixed' };
  }
  throw new Error('Direct Debit collection policy is unknown; administrator review is required.');
}

export function resolveSavedCollectionPolicy(snapshot = {}) {
  snapshot ||= {};
  const saved = snapshot.collection_policy ?? snapshot.commitment_snapshot?.collection_policy
    ?? snapshot.commitment?.commitment_snapshot?.collection_policy;
  if (saved != null) {
    const policy = explicitPolicy(saved);
    return policy
      ? { ...policy, evidence: 'explicit', needs_review: false }
      : { version: null, end_policy: null, pricing_policy: 'fixed', evidence: 'invalid', needs_review: true };
  }
  if (typeof snapshot.auto_renew === 'boolean') {
    return {
      version: null, end_policy: snapshot.auto_renew ? 'continue' : 'stop',
      pricing_policy: 'fixed', evidence: 'legacy_auto_renew', needs_review: false,
    };
  }
  return { version: null, end_policy: null, pricing_policy: 'fixed', evidence: 'missing', needs_review: true };
}

export function describeCollectionPolicy(policy) {
  if (!policy || policy.needs_review || !ends.includes(policy.end_policy)) {
    return 'Collection continuation is not evidenced. Administrator review is required; existing fixed prices are retained.';
  }
  const end = policy.end_policy === 'continue'
    ? 'Collections continue into each new membership term.'
    : 'Collections stop at term end; renewal is required before further collections.';
  const price = policy.pricing_policy === 'dynamic'
    ? 'Each monthly collection uses the applicable active membership structure price, subject to provider notice deadlines.'
    : policy.end_policy === 'continue'
      ? 'The amount is fixed for each term and restamped from the active price at renewal.'
      : 'The monthly amount is fixed for the membership term.';
  return `${end} ${price}`;
}