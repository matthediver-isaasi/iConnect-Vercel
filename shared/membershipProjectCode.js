// A pricing-structure setting, never a PO reference or an add-on setting.
export function normalizeMembershipProjectCode(value) {
  return typeof value === 'string' ? value.trim() || null : null;
}

export function membershipProjectTracking(value) {
  const code = normalizeMembershipProjectCode(value);
  return code ? { Tracking: [{ Name: 'Projects', Option: code }] } : {};
}
