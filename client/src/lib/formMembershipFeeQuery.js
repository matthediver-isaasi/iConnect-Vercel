// Scope appears exactly once. Repeated query keys become arrays in the API
// adapter and cannot be compared to the persisted checkout's scalar identity.
export function formMembershipFeeQuery({ memberId, overrideParams = '', checkoutId }) {
  const query = new URLSearchParams(overrideParams.replace(/^&/, ''));
  for (const key of [...new Set(query.keys())]) query.set(key, query.get(key));
  query.set('memberId', memberId);
  if (checkoutId) query.set('voucherCheckoutId', checkoutId);
  return query.toString();
}
