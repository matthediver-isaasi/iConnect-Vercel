// Task #1626: Role term snapshotting.
//
// Term length (value + unit) and max terms live on the ROLE definition
// (member_group.role_term_definitions, keyed by role title). When a member is
// awarded a vacancy or accepts a direct invite, a FIXED snapshot of the role's
// term is written onto their member_group_assignment so later role edits don't
// retroactively change an already-awarded member's recorded term.
//
// This client copy mirrors api/_lib/memberGroupTermSnapshot.js — keep them in
// sync. Pure, no imports.

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

// Build the term snapshot to write onto an assignment.
//  - termDef: the role's entry from member_group.role_term_definitions
//  - existingAssignment: the member's current assignment (or null). Renewing
//    into the SAME role increments term_number; a new/different role resets to 1.
//  - role: the role being assigned.
//  - startDate: term start (defaults to now).
// Returns null snapshot fields when the role carries no term definition.
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

// Advisory check used at award / invite time: would assigning a member into
// `role` push their next term_number beyond the role's max_terms? Returns
// { nextTermNumber, maxTerms } when it would exceed, otherwise null. Purely
// informational — callers decide whether to warn or block (Task #1630).
export function evaluateTermLimit(termDef, { existingAssignment = null, role = '' } = {}) {
  const snapshot = buildTermSnapshot(termDef, { existingAssignment, role });
  const nextTermNumber = snapshot.term_number;
  const maxTerms = snapshot.max_terms;
  if (maxTerms == null || nextTermNumber == null) return null;
  if (nextTermNumber > maxTerms) return { nextTermNumber, maxTerms };
  return null;
}

const TERM_UNIT_LABELS = { months: 'months', years: 'years' };

// Human label for a term length, e.g. "3 years". Accepts an assignment-style
// object ({ term_length_value, term_length_unit }) or a role-def-style object
// ({ term_value, term_unit }).
export function formatTermLength(obj) {
  if (!obj) return null;
  const value = obj.term_length_value ?? obj.term_value;
  const unit = obj.term_length_unit ?? obj.term_unit;
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unitLabel = TERM_UNIT_LABELS[unit] || unit || '';
  return `${n} ${unitLabel}`.trim();
}
