/**
 * Task #3330: shared client-side condition evaluation for survey Score fields.
 *
 * Score answers are stored as objects ({ score: n } or { na: true }), and
 * surveys add numeric comparison operators. Each form surface's own
 * evaluateSingleCondition delegates here first; `undefined` means "not a
 * survey/numeric case — fall through to the existing logic".
 *
 * Mirrors the server-side operators in api/_lib/surveyScoring.js.
 */

export const SCORE_CONDITION_OPERATORS = [
  { value: 'equals', label: 'Equals' },
  { value: 'not_equals', label: 'Does not equal' },
  { value: 'greater_than', label: 'Greater than' },
  { value: 'greater_than_or_equal', label: 'Greater than or equal' },
  { value: 'less_than', label: 'Less than' },
  { value: 'less_than_or_equal', label: 'Less than or equal' },
  { value: 'between', label: 'Between (e.g. 2,4)' },
];

const NUMERIC_OPERATORS = new Set([
  'greater_than', 'greater_than_or_equal', 'less_than', 'less_than_or_equal', 'between'
]);

export function toScoreNumber(triggerValue) {
  let v = triggerValue;
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    if (v.na === true) return null;
    v = v.score;
  }
  if (v === undefined || v === null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const isScoreObject = (v) => v && typeof v === 'object' && !Array.isArray(v) && ('score' in v || 'na' in v);

/**
 * Returns true/false when this helper owns the comparison, otherwise undefined.
 */
export function evaluateScoreCondition(triggerValue, operator, value) {
  const numeric = toScoreNumber(triggerValue);

  if (NUMERIC_OPERATORS.has(operator)) {
    if (numeric === null) return false;
    if (operator === 'between') {
      let lo; let hi;
      if (Array.isArray(value)) { [lo, hi] = value; }
      else if (typeof value === 'string') { [lo, hi] = value.split(/[,–-]/).map((s) => s.trim()); }
      else if (value && typeof value === 'object') { lo = value.from; hi = value.to; }
      lo = Number(lo); hi = Number(hi);
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) return false;
      return numeric >= Math.min(lo, hi) && numeric <= Math.max(lo, hi);
    }
    const compare = Number(value);
    if (!Number.isFinite(compare)) return false;
    switch (operator) {
      case 'greater_than': return numeric > compare;
      case 'greater_than_or_equal': return numeric >= compare;
      case 'less_than': return numeric < compare;
      case 'less_than_or_equal': return numeric <= compare;
      default: return false;
    }
  }

  // equals/not_equals/empty checks on score-object answers
  if (isScoreObject(triggerValue)) {
    switch (operator) {
      case 'equals': {
        const compare = Number(value);
        return numeric !== null && Number.isFinite(compare) && numeric === compare;
      }
      case 'not_equals': {
        const compare = Number(value);
        return numeric === null || !Number.isFinite(compare) || numeric !== compare;
      }
      case 'not_empty': return true; // an object answer (score or N/A) is an answer
      case 'is_empty': return false;
      default: return undefined;
    }
  }

  return undefined;
}
