// Organization columns that are ledger-backed: every change must go through
// a path that writes a training_fund_transaction row atomically in the same
// DB transaction (dedicated RPCs / admin endpoints). Generic write paths
// (entity API, workflow executors, form field mappings) must strip or skip
// these fields so balance and ledger can never silently diverge.
export const PROTECTED_ORG_BALANCE_FIELDS = Object.freeze([
  'training_fund_balance',
  'training_fund_pending_balance',
]);

export function isProtectedOrgBalanceField(fieldId) {
  return PROTECTED_ORG_BALANCE_FIELDS.includes(fieldId);
}

/**
 * Deletes any protected ledger-backed balance fields from a mutable request
 * body (in place). Returns the list of stripped field names so callers can
 * log the event. Used by BOTH the generic entity API create (POST) and
 * update (PATCH) paths for Organization.
 */
export function stripProtectedOrgBalanceFields(body) {
  const stripped = [];
  if (!body || typeof body !== 'object') return stripped;
  for (const f of PROTECTED_ORG_BALANCE_FIELDS) {
    if (f in body) {
      delete body[f];
      stripped.push(f);
    }
  }
  return stripped;
}
