// Task #1626: Role term snapshotting (server copy).
//
// Term length (value + unit) and max terms live on the ROLE definition
// (member_group.role_term_definitions, keyed by role title). When a member
// accepts a direct invite (or is awarded a vacancy), a FIXED snapshot of the
// role's term is written onto their member_group_assignment so later role edits
// don't retroactively change an already-awarded member's recorded term.
//
// Mirror of client/src/lib/memberGroupTermSnapshot.js — keep them in sync.

export function normalizeTermDefinition(def) {
  if (!def || typeof def !== 'object') return null;
  const value = Number(def.term_value);
  const maxTerms = Number(def.max_terms);
  const hasValue = Number.isFinite(value) && value > 0;
  const hasMax = Number.isFinite(maxTerms) && maxTerms > 0;
  if (!hasValue && !hasMax) return null;
  return {
    term_value: hasValue ? Math.floor(value) : null,
    term_unit: hasValue ? (def.term_unit === 'months' ? 'months' : 'years') : null,
    max_terms: hasMax ? Math.floor(maxTerms) : null,
  };
}

function addTerm(start, value, unit) {
  const d = new Date(start.getTime());
  if (unit === 'months') d.setMonth(d.getMonth() + value);
  else d.setFullYear(d.getFullYear() + value);
  return d;
}

function toDateOnly(d) {
  return d.toISOString().slice(0, 10);
}

const EMPTY_SNAPSHOT = {
  term_length_value: null,
  term_length_unit: null,
  max_terms: null,
  term_start_date: null,
  term_end_date: null,
  term_number: null,
};

export function resolveRoleTermDefinition(group, role) {
  const map = group?.role_term_definitions;
  if (!map || typeof map !== 'object') return null;
  return map[role] || null;
}

// Build the term snapshot to write onto an assignment. See the client copy for
// the full contract. Returns null snapshot fields when the role carries no term
// definition.
export function buildTermSnapshot(termDef, { existingAssignment = null, role = '', startDate } = {}) {
  const norm = normalizeTermDefinition(termDef);
  if (!norm) return { ...EMPTY_SNAPSHOT };

  const start = startDate ? new Date(startDate) : new Date();

  let termNumber = 1;
  if (
    existingAssignment &&
    existingAssignment.group_role === role &&
    Number.isFinite(Number(existingAssignment.term_number)) &&
    Number(existingAssignment.term_number) > 0
  ) {
    termNumber = Number(existingAssignment.term_number) + 1;
  }

  return {
    term_length_value: norm.term_value,
    term_length_unit: norm.term_unit,
    max_terms: norm.max_terms,
    term_start_date: toDateOnly(start),
    term_end_date: norm.term_value ? toDateOnly(addTerm(start, norm.term_value, norm.term_unit)) : null,
    term_number: termNumber,
  };
}

// Advisory check: would assigning a member into `role` push their next
// term_number beyond the role's max_terms? Returns { nextTermNumber, maxTerms }
// when it would exceed, otherwise null. Mirror of the client copy (Task #1630).
export function evaluateTermLimit(termDef, { existingAssignment = null, role = '' } = {}) {
  const snapshot = buildTermSnapshot(termDef, { existingAssignment, role });
  const nextTermNumber = snapshot.term_number;
  const maxTerms = snapshot.max_terms;
  if (maxTerms == null || nextTermNumber == null) return null;
  if (nextTermNumber > maxTerms) return { nextTermNumber, maxTerms };
  return null;
}
