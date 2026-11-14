import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateAssessment, validateCriteria, aggregateAssessments, formatScore, compareScores, shortlistRecommendations } from './scoring.js';

const criterion = (id, weight, max = 5) => ({ id, title: id, type: 'numeric', required: true, min: 0, max, weight });
const definition = { optionalPolicy: 'incomplete', criteria: [criterion('a', 50), criterion('b', 50, 10)] };
const result = (a, b) => calculateAssessment(definition, { a: { value: a }, b: { value: b } }, { final: true });

test('mixed ranges normalise equally with exact, reproducible arithmetic', () => {
  assert.equal(formatScore(result(4, 8).score), '80.00');
  assert.deepEqual(result(4, 8).score, { numerator: '80', denominator: '1' });
  const shifted = { optionalPolicy: 'incomplete', criteria: [{ ...criterion('a', 100), min: -5 }] };
  assert.equal(formatScore(calculateAssessment(shifted, { a: { value: -2.5 } }).score), '25.00');
});
test('rejects absent policy, invalid weight totals, duplicate criteria and coercion', () => {
  assert.throws(() => validateCriteria({ criteria: definition.criteria }), /policy/);
  assert.throws(() => validateCriteria({ ...definition, criteria: [criterion('a', 99)] }), /100/);
  assert.throws(() => validateCriteria({ ...definition, criteria: [criterion('a', 50), criterion('a', 50)] }), /unique/);
  for (const value of [true, [], {}, NaN, Infinity, ' ', '0x4', '2e0', '4junk']) assert.throws(() => result(value, 8));
  assert.throws(() => result(6, 8), /range/);
});
test('optional absence never becomes zero; selected policy is explicit', () => {
  const d = { ...definition, criteria: [definition.criteria[0], { ...definition.criteria[1], required: false }] };
  const answers = { a: { value: 4 } };
  assert.equal(calculateAssessment(d, answers, { final: true }).score, null);
  assert.equal(formatScore(calculateAssessment({ ...d, optionalPolicy: 'renormalise' }, answers).score), '80.00');
  const optional = { ...d, optionalPolicy: 'renormalise', criteria: d.criteria.map(c => ({ ...c, required: false })) };
  assert.equal(calculateAssessment(optional, {}).score, null);
});
test('required responses and comments block locking, not draft storage', () => {
  assert.equal(calculateAssessment(definition, {}).errors.length, 2);
  assert.throws(() => calculateAssessment(definition, {}, { final: true }), /required/);
  const d = { ...definition, criteria: definition.criteria.map(c => ({ ...c, commentsRequired: true })) };
  assert.throws(() => calculateAssessment(d, { a: { value: 4 }, b: { value: 8 } }, { final: true }), /comments/);
  assert.throws(() => calculateAssessment(definition, { unknown: { value: 4 } }), /Unknown/);
});
test('mapped, binary and text criteria preserve qualification flags without scoring them', () => {
  const d = { optionalPolicy: 'incomplete', criteria: [
    { id: 'rating', title: 'Merit', type: 'rating', min: 1, max: 5, weight: 100, required: true,
      options: [{ key: 'poor', value: 1 }, { key: 'good', value: 4 }] },
    { id: 'qualified', title: 'Qualified', type: 'yes_no', effect: 'qualification', required: true },
    { id: 'review', title: 'Review', type: 'pass_fail', effect: 'review', required: true },
    { id: 'commentary', title: 'Commentary', type: 'text', required: false },
  ] };
  const r = calculateAssessment(d, { rating: { value: 'good' }, qualified: { value: 'no' }, review: { value: 'fail' }, commentary: { value: 'Review required' } }, { final: true });
  assert.equal(formatScore(r.score), '75.00');
  assert.equal(r.flags.length, 2);
  assert.throws(() => calculateAssessment(d, { rating: { value: 'unknown' } }), /Unknown rating/);
});
test('aggregation excludes nonfinal evidence and enforces count/all-required policies', () => {
  const a = { assignmentId: 'one', state: 'submitted', included: true, score: result(4, 8).score };
  const options = { minimum: 2, requiredAssignments: ['one', 'two', 'three'] };
  const other = { ...a, assignmentId: 'two', score: result(5, 10).score };
  const incomplete = aggregateAssessments([a, { ...other, state: 'draft' }], options);
  assert.equal(formatScore(incomplete.provisionalAverage), '80.00');
  assert.equal(incomplete.officialScore, null);
  for (const patch of [{ recused: true }, { included: false }, { superseded: true }, { score: null }]) {
    assert.equal(aggregateAssessments([a, { ...other, ...patch }], options).complete, false);
  }
  const complete = aggregateAssessments([a, other], options);
  assert.equal(formatScore(complete.officialScore), '90.00');
  assert.equal(complete.discrepancy, true);
  assert.equal(aggregateAssessments([a, other], { ...options, allRequired: true }).complete, false);
  assert.throws(() => aggregateAssessments([a, a], options), /Multiple/);
});
test('only approved moderation takes precedence and cannot conceal incomplete judging', () => {
  const a = { assignmentId: 'one', state: 'submitted', included: true, score: result(4, 8).score };
  const options = { minimum: 1, requiredAssignments: ['one'], approvedModeration: { state: 'approved', score: result(5, 10).score } };
  assert.equal(formatScore(aggregateAssessments([a], options).officialScore), '100.00');
  assert.equal(formatScore(aggregateAssessments([a], options).finalAverage), '80.00');
  assert.equal(aggregateAssessments([a], { ...options, minimum: 2 }).officialScore, null);
  assert.throws(() => aggregateAssessments([a], { ...options, approvedModeration: { ...options.approvedModeration, state: 'proposed' } }), /approved/);
});
test('cutoff ties require decisions and rounded equality never creates ties', () => {
  const score = n => ({ numerator: String(n), denominator: '10000' });
  assert.equal(formatScore(score(800001)), formatScore(score(800002)));
  assert.equal(compareScores(score(800001), score(800002)), -1);
  const entries = ['one', 'two', 'three'].map(id => ({ id, eligibility: 'eligible', complete: true, officialScore: score(800001) }));
  const tied = shortlistRecommendations(entries, { mode: 'top_ranked', limit: 2 });
  assert.deepEqual(tied.recommended, []);
  assert.equal(tied.tied.length, 3);
  entries[0].officialScore = score(800002);
  assert.deepEqual(shortlistRecommendations(entries, { mode: 'top_ranked', limit: 1 }).recommended, ['one']);
  entries[0].eligibility = 'withdrawn';
  assert.equal(shortlistRecommendations(entries, { mode: 'threshold_approval', threshold: 80 }).recommended.includes('one'), false);
});
