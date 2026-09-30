// Generic CRUD is not a payment/renewal authorization boundary. Only the
// membership services may create commitments or change committed records.
const TABLES = new Set([
  'member_membership_history',
  'organisation_membership_history',
  'membership_billing_agreements',
]);
const FIELDS = new Set([
  'term_key', 'membership_renewal_date',
  'term_duration_months', 'term_anchor_date', 'previous_term_id',
  'commitment_snapshot',
]);

export function isCommitmentTable(table) {
  return TABLES.has(table);
}

export function hasGenericCommitmentFields(table, payload) {
  if (!isCommitmentTable(table) || !payload || typeof payload !== 'object') return false;
  if (Array.isArray(payload)) return payload.some(row => hasGenericCommitmentFields(table, row));
  if (Object.keys(payload).some(key => FIELDS.has(key))) return true;
  if (payload.metadata?.commitment || payload.metadata?.card?.commitment || payload.metadata?.dd?.commitment) return true;
  return ['rows', 'records', 'items', 'data'].some(key =>
    Array.isArray(payload[key]) && hasGenericCommitmentFields(table, payload[key]));
}

// Applying the predicate on the mutation itself closes the race between a
// read-only guard and a concurrent payment finalizer attaching a commitment.
export function constrainGenericCommitmentMutation(table, query) {
  return isCommitmentTable(table) ? query.is('term_key', null) : query;
}