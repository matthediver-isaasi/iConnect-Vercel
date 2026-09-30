import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateScoreFieldConfig,
  validateSurveyForPublish,
  parseScoreAnswer,
  evaluateSurveyCondition,
  computeHiddenFieldIds,
  scoreSubmission,
  getScoreRange,
  activeVersionNumber,
} from './surveyScoring.js';

const scoreField = (over = {}) => ({
  id: 'q1', type: 'score', label: 'Quality', score_style: 'numbers',
  score_min: 1, score_max: 5, weight: 1, ...over
});

test('config validation: whole numbers, max > min, button cap, style fit', () => {
  assert.equal(validateScoreFieldConfig(scoreField()).errors.length, 0);
  assert.ok(validateScoreFieldConfig(scoreField({ score_min: 1.5 })).errors.some(e => e.includes('whole')));
  assert.ok(validateScoreFieldConfig(scoreField({ score_min: 5, score_max: 5 })).errors.some(e => e.includes('greater')));
  assert.ok(validateScoreFieldConfig(scoreField({ score_min: 0, score_max: 11 })).errors.some(e => e.includes('at most 11')));
  // slider allows wide ranges
  assert.equal(validateScoreFieldConfig(scoreField({ score_style: 'slider', score_min: 0, score_max: 100 })).errors.length, 0);
  assert.ok(validateScoreFieldConfig(scoreField({ score_style: 'smileys', score_min: 1, score_max: 10 })).warnings.length > 0);
  assert.ok(validateScoreFieldConfig(scoreField({ weight: 0 })).errors.some(e => e.includes('Weighting')));
});

test('nps preset forces 0-10', () => {
  assert.deepEqual(getScoreRange({ type: 'score', score_style: 'nps', score_min: 1, score_max: 5 }), { min: 0, max: 10 });
});

test('publish validation summary', () => {
  const fields = [
    scoreField(),
    scoreField({ id: 'q2', weight: 2, include_in_overall: false }),
    scoreField({ id: 'q3', reporting_category: 'Venue', weight: 0.5 }),
    { id: 't1', type: 'text', label: 'Comments' },
    { id: 'i1', type: 'instructions', label: '' }
  ];
  const { errors, summary } = validateSurveyForPublish(fields, {});
  assert.equal(errors.length, 0);
  assert.equal(summary.scoredCount, 3);
  assert.equal(summary.nonScoredCount, 1);
  assert.equal(summary.totalWeight, 1.5);
  assert.deepEqual(summary.excludedFromOverall, ['q2']);
  assert.deepEqual(summary.missingCategory, ['q1', 'q2']);
  assert.ok(validateSurveyForPublish([], {}).errors.some(e => e.message.includes('at least one Score')));
});

test('parseScoreAnswer shapes', () => {
  assert.deepEqual(parseScoreAnswer({ score: 4 }), { answered: true, na: false, score: 4 });
  assert.deepEqual(parseScoreAnswer({ na: true }), { answered: true, na: true });
  assert.deepEqual(parseScoreAnswer('NA'), { answered: true, na: true });
  assert.deepEqual(parseScoreAnswer('3'), { answered: true, na: false, score: 3 });
  assert.equal(parseScoreAnswer(undefined).answered, false);
  assert.equal(parseScoreAnswer({ score: 3.5 }).invalid, true);
  // client-supplied weight is ignored entirely
  assert.deepEqual(parseScoreAnswer({ score: 2, weight: 99 }), { answered: true, na: false, score: 2 });
});

test('numeric condition operators', () => {
  assert.ok(evaluateSurveyCondition({ score: 7 }, 'greater_than', 5));
  assert.ok(!evaluateSurveyCondition({ score: 5 }, 'greater_than', 5));
  assert.ok(evaluateSurveyCondition({ score: 5 }, 'greater_than_or_equal', 5));
  assert.ok(evaluateSurveyCondition({ score: 3 }, 'less_than', '4'));
  assert.ok(evaluateSurveyCondition({ score: 4 }, 'less_than_or_equal', 4));
  assert.ok(evaluateSurveyCondition({ score: 4 }, 'between', '2,6'));
  assert.ok(!evaluateSurveyCondition({ score: 8 }, 'between', [2, 6]));
  assert.ok(evaluateSurveyCondition({ score: 4 }, 'equals', '4'));
  assert.ok(evaluateSurveyCondition({ na: true }, 'is_empty', undefined) === false); // na is an answer, not empty text
  assert.ok(!evaluateSurveyCondition({ na: true }, 'greater_than', 1));
});

test('hidden field computation honours show rules with numeric conditions', () => {
  const fields = [scoreField(), scoreField({ id: 'q2', starts_hidden: true })];
  const rules = [{
    rule_type: 'visibility',
    conditions: [{ field_id: 'q1', operator: 'less_than', value: 3 }],
    logic: 'AND',
    actions: [{ action_type: 'visibility', field_states: { q2: { visible: true } } }]
  }];
  assert.ok(computeHiddenFieldIds(fields, [], rules, { q1: { score: 5 } }).has('q2'));
  assert.ok(!computeHiddenFieldIds(fields, [], rules, { q1: { score: 2 } }).has('q2'));
});

test('scoreSubmission: normalisation, reverse, weights, exclusions', () => {
  const version = {
    fields: [
      scoreField({ id: 'a', weight: 2 }),                          // 5 -> 1.0
      scoreField({ id: 'b', reverse_scoring: true }),               // 5 -> 0.0
      scoreField({ id: 'c', allow_na: true }),                      // NA -> excluded
      scoreField({ id: 'd', include_in_overall: false }),           // excluded from overall
      scoreField({ id: 'e', required: false }),                     // unanswered optional -> excluded
      scoreField({ id: 'f', starts_hidden: true }),                 // hidden -> excluded
      { id: 't', type: 'text', label: 'Comments' }
    ],
    pages: [],
    visibility_rules: []
  };
  const result = scoreSubmission(version, {
    a: { score: 5 }, b: { score: 5 }, c: { na: true }, d: { score: 3 }, t: 'hello'
  });
  assert.deepEqual(result.errors, []);
  // weighted: (1.0*2 + 0.0*1) / 3 = 0.666667 ; unweighted: (1.0 + 0.0)/2 = 0.5
  assert.equal(result.overallWeighted, 0.666667);
  assert.equal(result.overallUnweighted, 0.5);
  const byId = Object.fromEntries(result.answers.map(a => [a.field_id, a]));
  assert.equal(byId.a.normalised_score, 1);
  assert.equal(byId.b.normalised_score, 0);
  assert.equal(byId.c.is_na, true);
  assert.equal(byId.c.included_in_overall, false);
  assert.equal(byId.d.included_in_overall, false);
  assert.equal(byId.d.weighted_contribution, null);
  assert.ok(!byId.e);
  assert.ok(!byId.f);
});

test('scoreSubmission rejections', () => {
  const version = { fields: [scoreField({ id: 'a', required: true })], pages: [], visibility_rules: [] };
  assert.ok(scoreSubmission(version, { a: { score: 9 } }).errors.some(e => e.includes('between 1 and 5')));
  assert.ok(scoreSubmission(version, { a: { na: true } }).errors.some(e => e.includes('Not Applicable')));
  assert.ok(scoreSubmission(version, {}).errors.some(e => e.includes('required')));
  assert.ok(scoreSubmission(version, { a: { score: 3 }, ghost: { score: 3 } }).errors.some(e => e.includes('not part of this survey')));
  // score-shaped answer aimed at a non-score field is rejected
  const v2 = { fields: [scoreField({ id: 'a', required: false }), { id: 't', type: 'text' }], pages: [], visibility_rules: [] };
  assert.ok(scoreSubmission(v2, { t: { score: 4 } }).errors.some(e => e.includes('non-score')));
  // hidden required question is NOT required
  const v3 = { fields: [scoreField({ id: 'a', required: true, starts_hidden: true })], pages: [], visibility_rules: [] };
  assert.deepEqual(scoreSubmission(v3, {}).errors, []);
});

test('redactIdentityAnswers strips identity-bearing fields for anonymous surveys', async () => {
  const { redactIdentityAnswers } = await import('./surveyScoring.js');
  const fields = [
    { id: 'f_email', type: 'email', label: 'Work address' },
    { id: 'f_phone', type: 'tel', label: 'Phone' },
    { id: 'f_name', type: 'text', label: 'Your Name' },
    { id: 'f_score', type: 'score', label: 'How satisfied?' },
    { id: 'f_comment', type: 'textarea', label: 'Comments' },
    { id: 'f_sig', type: 'signature', label: 'Sign here' }
  ];
  const { data, redactedFieldIds } = redactIdentityAnswers(fields, {
    f_email: 'alice@example.com',
    f_phone: '07700 900123',
    f_name: 'Alice Smith',
    f_score: { score: 4 },
    f_comment: 'Great event',
    f_sig: 'data:image/png;base64,xyz'
  });
  assert.deepEqual(data, { f_score: { score: 4 }, f_comment: 'Great event' });
  assert.deepEqual(new Set(redactedFieldIds), new Set(['f_email', 'f_phone', 'f_name', 'f_sig']));
  // label/id heuristic also catches untyped identity fields
  const r2 = redactIdentityAnswers([{ id: 'x', type: 'text', label: 'First name' }], { x: 'Bob' });
  assert.deepEqual(r2.data, {});
  // unknown keys with identity-looking ids are also stripped
  const r3 = redactIdentityAnswers([], { email_field: 'c@d.com', other: 'keep' });
  assert.deepEqual(r3.data, { other: 'keep' });
});

test('anonymous redaction is driven by the published snapshot fields, not live edits', async () => {
  const { redactIdentityAnswers } = await import('./surveyScoring.js');
  // At publish time the snapshot recorded f1 as an email field.
  const snapshotFields = [
    { id: 'f1', type: 'email', label: 'Email' },
    { id: 'f2', type: 'score', label: 'Rating' }
  ];
  // Afterwards, an admin renames/retypes f1 on the LIVE draft to dodge redaction.
  const liveFields = [
    { id: 'f1', type: 'text', label: 'Reference code' },
    { id: 'f2', type: 'score', label: 'Rating' }
  ];
  const submitted = { f1: 'alice@example.com', f2: { score: 5 } };
  // The endpoint must redact against the snapshot (as form-submission.js does):
  const snapshotResult = redactIdentityAnswers(snapshotFields, submitted);
  assert.deepEqual(snapshotResult.data, { f2: { score: 5 } });
  // Redacting against the tampered live config would have leaked the email —
  // proving the snapshot source is what protects anonymity.
  const liveResult = redactIdentityAnswers(liveFields, submitted);
  assert.equal(liveResult.data.f1, 'alice@example.com');
});

test('anonymizeSubmissionRecord nulls identity and network metadata columns', async () => {
  const { anonymizeSubmissionRecord } = await import('./surveyScoring.js');
  const record = anonymizeSubmissionRecord({
    form_id: 'f1',
    submitted_by_email: 'a@b.com',
    submitted_by_name: 'Alice',
    member_id: 'm1',
    created_member_id: 'm1',
    ip_address: '203.0.113.9',
    user_agent: 'Mozilla/5.0',
    submission_data: { q: { score: 4 } },
    survey_respondent_key: 'hash',
    tenant_id: 't1'
  });
  assert.equal(record.submitted_by_email, null);
  assert.equal(record.submitted_by_name, null);
  assert.equal(record.member_id, null);
  assert.equal(record.created_member_id, null);
  assert.equal(record.ip_address, null);
  assert.equal(record.user_agent, null);
  // non-identity payload untouched
  assert.deepEqual(record.submission_data, { q: { score: 4 } });
  assert.equal(record.survey_respondent_key, 'hash');
  assert.equal(record.tenant_id, 't1');
  // even a record that never carried the columns comes out with explicit nulls
  const bare = anonymizeSubmissionRecord({ form_id: 'f2' });
  assert.equal(bare.ip_address, null);
  assert.equal(bare.user_agent, null);
  assert.equal(bare.submitted_by_email, null);
});

test('activeVersionNumber selects the pointed-at snapshot, never the highest', () => {
  // v1 published, edited (draft), v2 published, then v1 config re-published:
  // publish reuse sets current_version back to 1 while a v2 row still exists.
  const versions = [
    { version_number: 1, fields: [{ id: 'a' }] },
    { version_number: 2, fields: [{ id: 'b' }] }
  ];
  const active = activeVersionNumber({ status: 'published', current_version: 1 });
  assert.equal(active, 1);
  const chosen = versions.find(v => v.version_number === active);
  assert.deepEqual(chosen.fields, [{ id: 'a' }]);
  // Missing/invalid pointer resolves to 0 => no snapshot row => submission rejected.
  assert.equal(activeVersionNumber({}), 0);
  assert.equal(activeVersionNumber(null), 0);
  assert.equal(activeVersionNumber({ current_version: 'x' }), 0);
});

test('anonymizeSubmissionRecord strips linkage foreign keys, incl. crafted prefill org', async () => {
  const { anonymizeSubmissionRecord } = await import('./surveyScoring.js');
  const rec = anonymizeSubmissionRecord({
    form_id: 'f1', tenant_id: 't1', submission_data: { q1: { score: 3 } },
    organization_id: 'attacker-supplied-prefill-org',
    contract_instance_id: 'c1', vacancy_id: 'v1', event_id: 'e1',
    brief_id: 'b1', role_id: 'r1', created_organization_id: 'o2',
    member_id: 'm1', submitted_by_email: 'x@y.z', ip_address: '1.2.3.4'
  });
  for (const col of ['organization_id', 'created_organization_id', 'contract_instance_id',
    'vacancy_id', 'event_id', 'brief_id', 'role_id', 'member_id',
    'submitted_by_email', 'ip_address']) {
    assert.equal(rec[col], null, col);
  }
  assert.equal(rec.form_id, 'f1');
  assert.deepEqual(rec.submission_data, { q1: { score: 3 } });
});
