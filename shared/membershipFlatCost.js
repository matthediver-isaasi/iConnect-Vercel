export function parseFlatMembershipCost(value) {
  if (value === null || value === undefined || String(value).trim() === '') {
    return { valid: false, error: 'Please enter a flat membership cost of 0 or more' };
  }

  const cost = Number(value);
  if (!Number.isFinite(cost) || cost < 0) {
    return { valid: false, error: 'Please enter a valid flat membership cost of 0 or more' };
  }

  return { valid: true, value: cost };
}