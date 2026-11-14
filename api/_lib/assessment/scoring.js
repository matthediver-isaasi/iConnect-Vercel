// Reusable assessment calculations. Exact rational arithmetic prevents rounded
// presentation values (and floating point addition order) deciding tied ranks.
const TYPES = new Set(['numeric', 'rating', 'yes_no', 'pass_fail', 'text']);
const OPTIONAL = new Set(['incomplete', 'renormalise']);
const gcd = (a, b) => b ? gcd(b, a % b) : a < 0n ? -a : a;
function rational(n, d = 1n) {
  if (!d) throw new Error('Division by zero');
  if (d < 0n) { n = -n; d = -d; }
  const g = gcd(n, d);
  return { n: n / g, d: d / g };
}
function decimal(value) {
  if (typeof value !== 'number' && typeof value !== 'string') throw new Error('A numeric value is required');
  const s = String(value);
  if (!/^-?\d{1,12}(?:\.\d{1,12})?$/.test(s)) throw new Error('Invalid decimal value');
  const [whole, fraction = ''] = s.split('.');
  return rational(BigInt(whole + fraction), 10n ** BigInt(fraction.length));
}
const add = (a, b) => rational(a.n * b.d + b.n * a.d, a.d * b.d);
const sub = (a, b) => rational(a.n * b.d - b.n * a.d, a.d * b.d);
const mul = (a, b) => rational(a.n * b.n, a.d * b.d);
const div = (a, b) => rational(a.n * b.d, a.d * b.n);
const compare = (a, b) => a.n * b.d < b.n * a.d ? -1 : a.n * b.d > b.n * a.d ? 1 : 0;
const zero = rational(0n);
const hundred = rational(100n);
const encode = a => ({ numerator: String(a.n), denominator: String(a.d) });
function decode(a) {
  if (!a || !/^-?\d{1,1000}$/.test(a.numerator) || !/^[1-9]\d{0,999}$/.test(a.denominator)) throw new Error('Invalid exact score');
  return rational(BigInt(a.numerator), BigInt(a.denominator));
}
export function compareScores(a, b) { return compare(decode(a), decode(b)); }
export function formatScore(score) {
  if (!score) return '—';
  const a = decode(score);
  const cents = (a.n * 100n * 2n + a.d) / (2n * a.d);
  return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}
const missing = v => v === undefined || v === null || typeof v === 'string' && !v.trim();
const scored = c => c.type === 'numeric' || c.type === 'rating';
const ensure = (test, message) => { if (!test) throw new Error(message); };

export function validateCriteria(definition) {
  ensure(definition && OPTIONAL.has(definition.optionalPolicy), 'Select an explicit optional-score policy');
  const criteria = definition.criteria;
  ensure(Array.isArray(criteria) && criteria.length > 0 && criteria.length <= 100, 'Provide between 1 and 100 criteria');
  const ids = new Set();
  let weight = zero;
  for (const c of criteria) {
    ensure(c && typeof c.id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(c.id) && !ids.has(c.id), 'Criterion IDs must be unique');
    ids.add(c.id);
    ensure(typeof c.title === 'string' && c.title.trim().length > 0 && c.title.length <= 500, 'Criterion title is required');
    ensure(TYPES.has(c.type), 'Unsupported criterion type');
    ensure(typeof c.required === 'boolean', 'Specify criterion requiredness');
    if (c.commentsRequired !== undefined) ensure(typeof c.commentsRequired === 'boolean', 'Invalid comments requirement');
    if (scored(c)) {
      const min = decimal(c.min), max = decimal(c.max), w = decimal(c.weight);
      ensure(compare(max, min) > 0, 'Maximum must exceed minimum');
      ensure(compare(w, zero) > 0 && compare(w, hundred) <= 0, 'Scored weights must be positive and at most 100');
      weight = add(weight, w);
      if (c.type === 'rating') {
        ensure(Array.isArray(c.options) && c.options.length >= 2 && c.options.length <= 100, 'Provide rating options');
        const keys = new Set();
        for (const option of c.options) {
          ensure(typeof option.key === 'string' && option.key.length > 0 && !keys.has(option.key), 'Rating keys must be unique');
          keys.add(option.key);
          const value = decimal(option.value);
          ensure(compare(value, min) >= 0 && compare(value, max) <= 0, 'Rating value outside range');
        }
      }
    } else {
      ensure(c.weight === undefined || compare(decimal(c.weight), zero) === 0, 'Informational criteria cannot carry weight');
      if (c.type !== 'text') ensure(['informational', 'qualification', 'review'].includes(c.effect), 'Specify binary criterion effect');
    }
  }
  ensure(compare(weight, hundred) === 0, 'Scored weights must total 100');
  return definition;
}

export function calculateAssessment(definition, answers, { final = false } = {}) {
  validateCriteria(definition);
  ensure(answers && typeof answers === 'object' && !Array.isArray(answers), 'Answers must be an object');
  const known = new Set(definition.criteria.map(c => c.id));
  ensure(Object.keys(answers).every(id => known.has(id)), 'Unknown criterion answer');
  const errors = [], contributions = [], flags = [];
  let total = zero, answeredWeight = zero, missingScored = false;
  for (const c of definition.criteria) {
    const answer = answers[c.id];
    ensure(answer === undefined || answer && typeof answer === 'object' && !Array.isArray(answer), 'Invalid criterion response');
    const value = answer?.value;
    if (answer?.comment !== undefined) ensure(typeof answer.comment === 'string' && answer.comment.length <= 20000, 'Invalid criterion comment');
    if (missing(value)) {
      if (c.required) errors.push({ criterionId: c.id, code: 'required' });
      if (scored(c)) missingScored = true;
      continue;
    }
    if (c.commentsRequired && missing(answer.comment)) errors.push({ criterionId: c.id, code: 'comment_required' });
    if (scored(c)) {
      const raw = c.type === 'rating' ? c.options.find(o => o.key === value)?.value : value;
      ensure(raw !== undefined, 'Unknown rating option');
      const number = decimal(raw), min = decimal(c.min), max = decimal(c.max);
      ensure(compare(number, min) >= 0 && compare(number, max) <= 0, 'Score outside criterion range');
      const weight = decimal(c.weight);
      const contribution = mul(div(sub(number, min), sub(max, min)), weight);
      total = add(total, contribution);
      answeredWeight = add(answeredWeight, weight);
      contributions.push({ criterionId: c.id, score: encode(contribution) });
    } else if (c.type === 'text') {
      ensure(typeof value === 'string' && value.length <= 20000, 'Text response is invalid');
    } else {
      const options = c.type === 'yes_no' ? ['yes', 'no'] : ['pass', 'fail'];
      ensure(options.includes(value), 'Binary response is invalid');
      if (value === options[1] && c.effect !== 'informational') flags.push({ criterionId: c.id, effect: c.effect });
    }
  }
  if (final && errors.length) {
    const error = new Error('Complete required responses and comments before submitting');
    error.code = 'ASSESSMENT_INCOMPLETE'; error.details = errors; throw error;
  }
  const canScore = errors.length === 0 && answeredWeight.n > 0n
    && (!missingScored || definition.optionalPolicy === 'renormalise');
  return {
    score: canScore ? encode(div(mul(total, hundred), answeredWeight)) : null,
    contributions, flags, errors, complete: errors.length === 0,
    scoringComplete: canScore,
  };
}

export function aggregateAssessments(assessments, {
  minimum, requiredAssignments, allRequired = false, approvedModeration = null,
  discrepancyThreshold = '20',
}) {
  ensure(Number.isInteger(minimum) && minimum > 0, 'Minimum assessments must be positive');
  ensure(Array.isArray(requiredAssignments) && new Set(requiredAssignments).size === requiredAssignments.length, 'Required assignments must be unique');
  const assigned = new Set(requiredAssignments);
  const included = assessments.filter(a => a.state === 'submitted' && a.included === true && !a.recused && !a.superseded && assigned.has(a.assignmentId));
  ensure(new Set(included.map(a => a.assignmentId)).size === included.length, 'Multiple current assessments for one assignment');
  const valid = included.filter(a => a.score !== null);
  const scores = valid.map(a => decode(a.score));
  scores.forEach(s => ensure(compare(s, zero) >= 0 && compare(s, hundred) <= 0, 'Assessment score outside range'));
  const average = scores.length ? div(scores.reduce(add, zero), rational(BigInt(scores.length))) : null;
  const complete = valid.length >= minimum && (!allRequired || valid.length === requiredAssignments.length);
  const ordered = [...scores].sort(compare);
  const threshold = decimal(discrepancyThreshold);
  ensure(compare(threshold, zero) >= 0 && compare(threshold, hundred) <= 0, 'Invalid discrepancy threshold');
  const discrepancy = ordered.length > 1 && compare(sub(ordered.at(-1), ordered[0]), threshold) >= 0;
  let moderated = null;
  if (approvedModeration) {
    ensure(approvedModeration.state === 'approved', 'Only approved moderation may affect ranking');
    moderated = decode(approvedModeration.score);
    ensure(compare(moderated, zero) >= 0 && compare(moderated, hundred) <= 0, 'Moderated score outside range');
  }
  return {
    completed: valid.length, required: minimum, complete, discrepancy,
    provisionalAverage: average && encode(average),
    finalAverage: complete && average ? encode(average) : null,
    officialScore: complete && average ? encode(moderated || average) : null,
  };
}

export function shortlistRecommendations(entries, { mode, threshold = '0', limit = null }) {
  ensure(['threshold', 'top_ranked', 'manual', 'threshold_approval'].includes(mode), 'Unknown shortlisting mode');
  ensure(limit === null || Number.isInteger(limit) && limit > 0, 'Shortlist limit must be positive');
  ensure(mode !== 'top_ranked' || limit !== null, 'Top-ranked selection requires a limit');
  const cutoff = decimal(threshold);
  ensure(compare(cutoff, zero) >= 0 && compare(cutoff, hundred) <= 0, 'Threshold outside range');
  ensure(new Set(entries.map(e => e.id)).size === entries.length, 'Duplicate application');
  if (mode === 'manual') return { recommended: [], tied: [], requiresDecision: true };
  const ranked = entries.filter(e => e.eligibility === 'eligible' && e.complete && e.officialScore)
    .filter(e => mode === 'top_ranked' || compare(decode(e.officialScore), cutoff) >= 0)
    .sort((a, b) => -compareScores(a.officialScore, b.officialScore));
  let selected = limit ? ranked.slice(0, limit) : ranked;
  let tied = [];
  if (limit && ranked.length > limit && compareScores(ranked[limit - 1].officialScore, ranked[limit].officialScore) === 0) {
    const boundary = ranked[limit].officialScore;
    tied = ranked.filter(e => compareScores(e.officialScore, boundary) === 0);
    selected = selected.filter(e => compareScores(e.officialScore, boundary) !== 0);
  }
  return { recommended: selected.map(e => e.id), tied: tied.map(e => e.id), requiresDecision: tied.length > 0 || mode === 'threshold_approval' };
}
