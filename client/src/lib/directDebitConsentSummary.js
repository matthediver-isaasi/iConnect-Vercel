export function directDebitCollectionPolicy(offer = {}) {
  return offer?.collectionPolicy || offer?.collection_policy || null;
}

export function directDebitPolicyText(offer = {}) {
  const policy = directDebitCollectionPolicy(offer);
  if (policy?.needs_review || !['stop', 'continue'].includes(policy?.end_policy)
    || !['fixed', 'dynamic'].includes(policy.pricing_policy)) {
    return 'Collection policy not recorded. An administrator must review the existing agreement; the billing period alone does not establish when collections end.';
  }
  const end = policy.end_policy === 'stop'
    ? 'Collections stop at the end of the billing period. Renewal is required before further collections.'
    : 'Collections continue at the end of the billing period into a new membership term.';
  const price = policy.pricing_policy === 'dynamic'
    ? 'Each monthly collection uses the current active membership structure price. The amount can change during the term; the displayed amount is a current price, not a guaranteed future charge. Collection timing and price changes remain subject to provider processing and advance notice.'
    : policy.end_policy === 'continue'
      ? 'The monthly amount is fixed for this membership term and restamped using active pricing at the next renewal.'
      : 'The monthly amount is fixed for this membership term; later structure price changes do not change this term’s amount.';
  return `${end} ${price}`;
}

export function directDebitHasFixedTermTotal(offer = {}) {
  return directDebitCollectionPolicy(offer)?.pricing_policy !== 'dynamic';
}

function ordinal(day) {
  const value = Number(day);
  if (!Number.isInteger(value) || value < 1 || value > 28) return null;
  const suffix = value % 10 === 1 && value !== 11
    ? 'st'
    : value % 10 === 2 && value !== 12
      ? 'nd'
      : value % 10 === 3 && value !== 13
        ? 'rd'
        : 'th';
  return `${value}${suffix}`;
}

export function directDebitFirstCollectionText({ firstCollectionRule, collectionDay } = {}) {
  if (firstCollectionRule === 'nominated_day') {
    const day = ordinal(collectionDay);
    if (day) return `On the next applicable ${day} of the month`;
  }
  if (firstCollectionRule === 'anniversary') {
    return 'On the next applicable monthly date matching the day your membership year starts';
  }
  return 'As soon as the mandate permits';
}