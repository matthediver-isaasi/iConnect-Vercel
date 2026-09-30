import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSurveyCompletionEmails } from './surveyCompletionTargeting.js';
import { withoutEnhancedSurveyAnswers, surveyAnswerDisplayDate } from './surveyCompletionOutputs.js';
import { rejectGenericServerOwnedEntity } from './serverOwnedEntityBoundary.js';

const settings = { anonymous_completion_version: 1, response_identity: 'anonymous' };
const form = { id: 'form', form_type: 'survey', related_event_id: 'event', survey_settings: { current_version: 3 } };
function database(tables, failures = {}) {
  const calls = [];
  return { calls, from(table) {
    const filters = []; let from = 0; let to = Infinity; let single = false;
    const query = {
      select(columns) { calls.push({ table, columns, filters }); return query; },
      eq(key, value) { filters.push([key, value]); return query; },
      is(key, value) { return query.eq(key, value); },
      in(key, values) { filters.push([key, values]); return query; },
      order() { return query; },
      range(start, end) { from = start; to = end; return query; },
      limit(n) { to = n - 1; return query; },
      maybeSingle() { single = true; return query; },
      then(resolve) {
        const rows = (tables[table] || []).filter(row => filters.every(([key, value]) =>
          Array.isArray(value) ? value.includes(row[key]) : row[key] === value)).slice(from, to + 1);
        return Promise.resolve({ data: single ? rows[0] || null : rows, error: failures[table] || null }).then(resolve);
      },
    };
    return query;
  } };
}
const version = { id: 'version', tenant_id: 'tenant', form_id: 'form', version_number: 3, survey_settings: settings };
test('standard bypasses new storage; all legacy form-wide surveys require reselection', async () => {
  const db = database({});
  assert.equal(await loadSurveyCompletionEmails(db, { tenantId: 'tenant', form: { ...form, form_type: 'standard' } }), null);
  assert.equal(db.calls.length, 0);
  for (const response_identity of ['identified', 'anonymous', 'anonymous_dedupe']) {
    const legacy = database({ survey_version: [{ ...version, survey_settings: { response_identity } }] });
    await assert.rejects(loadSurveyCompletionEmails(legacy, { tenantId: 'tenant', form }), /exact survey assignment/);
  }
});
test('completion paginates fully, pins tenant/form/assignment scope and never reads answers', async () => {
  const rows = Array.from({ length: 1001 }, (_, i) => ({
    id: String(i), tenant_id: 'tenant', form_id: 'form', assignment_id: 'assignment',
    recipient_email: `person${i}@example.com`, member_id: i === 1000 ? 'member' : null,
  }));
  rows.push({ ...rows[0], recipient_email: 'forged@example.com', tenant_id: 'other' });
  rows.push({ ...rows[0], recipient_email: 'other-event@example.com', assignment_id: 'other' });
  const db = database({ survey_version: [version], survey_completion: rows,
    event_survey_assignment: [{ id: 'assignment', tenant_id: 'tenant', form_id: 'form', event_type: 'event', event_id: 'event', survey_version_id: 'version' }],
    event: [{ id: 'event', tenant_id: 'tenant' }],
    member: [{ id: 'member', tenant_id: 'tenant', email: 'current@example.com' }] });
  const emails = await loadSurveyCompletionEmails(db, { tenantId: 'tenant', form, assignmentId: 'assignment' });
  assert.equal(emails.size, 1001);
  assert.ok(emails.has('person1000@example.com'));
  assert.ok(!emails.has('forged@example.com'));
  assert.ok(!emails.has('other-event@example.com'));
  assert.equal(db.calls.filter(c => c.table === 'survey_completion').length, 2);
  assert.ok(db.calls.every(c => !c.columns.includes('submission_data') && c.table !== 'survey_answer'));
});
test('assignment is mandatory when assigned; wrong event and evidence read failures fail closed', async () => {
  const assignment = { id: 'assignment', tenant_id: 'tenant', form_id: 'form', event_type: 'event', event_id: 'event', survey_version_id: 'version' };
  const tables = { survey_version: [version], event_survey_assignment: [assignment], event: [{ id: 'event', tenant_id: 'tenant' }] };
  await assert.rejects(loadSurveyCompletionEmails(database(tables), { tenantId: 'tenant', form }), /exact survey assignment/);
  await assert.rejects(loadSurveyCompletionEmails(database(tables), { tenantId: 'tenant', form, assignmentId: 'forged' }), /belonging/);
  await assert.rejects(loadSurveyCompletionEmails(database(tables, { survey_completion: new Error('DB') }),
    { tenantId: 'tenant', form, assignmentId: 'assignment' }), /targeting stopped/);
  const scoped = database({ ...tables, survey_completion: [
    { id: 'a', tenant_id: 'tenant', form_id: 'form', assignment_id: 'assignment', recipient_email: 'yes@example.com' },
    { id: 'b', tenant_id: 'tenant', form_id: 'form', assignment_id: 'other', recipient_email: 'no@example.com' },
  ] });
  assert.deepEqual([...await loadSurveyCompletionEmails(scoped, { tenantId: 'tenant', form, assignmentId: 'assignment' })], ['yes@example.com']);
});
test('generic outputs omit enhanced answers and fail closed on missing snapshots', async () => {
  const rows = [{ id: 'standard' }, { id: 'anonymous', survey_version_id: 'version' }];
  assert.deepEqual(await withoutEnhancedSurveyAnswers(database({ survey_version: [version] }), 'tenant', rows), [rows[0]]);
  await assert.rejects(withoutEnhancedSurveyAnswers(database({}), 'tenant', rows), /privacy policy/);
  const date = '2026-10-01T12:34:56.789Z';
  assert.equal(surveyAnswerDisplayDate(date, settings), '2026-10-01');
  assert.equal(surveyAnswerDisplayDate(date, {}), date);
  for (const entity of ['SurveyCompletion', 'survey_completion_retry']) {
    let status;
    assert.equal(rejectGenericServerOwnedEntity(entity, { status(n) { status = n; return this; }, json() {} }), true);
    assert.equal(status, 403);
  }
});