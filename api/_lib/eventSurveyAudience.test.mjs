import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveEventSurveyAudience, validateSurveyAudienceSegments } from './eventSurveyAudience.js';

function database(tables, failures = {}) {
  const calls = [];
  return { calls, from(table) {
    const filters = []; let start = 0; let end = Infinity; let single = false;
    const call = { table, filters };
    calls.push(call);
    const query = {
      select(columns) { call.columns = columns; return query; },
      eq(key, value) { filters.push([key, value]); return query; },
      order(key) { call.order = key; return query; },
      range(a, b) { start = a; end = b; call.start = a; return query; },
      maybeSingle() { single = true; return query; },
      then(resolve) {
        const rows = (tables[table] || []).filter(row => filters.every(([key, value]) => row[key] === value)).slice(start, end + 1);
        return Promise.resolve({ data: single ? rows[0] || null : rows, error: failures[table] || null }).then(resolve);
      },
    };
    return query;
  } };
}
const segment = { type: 'event_form', form_id: 'form', survey_assignment_id: 'assignment', received: true };
function fixture(type = 'event', settings = { response_identity: 'identified' }) {
  const scoped = { tenant_id: 'tenant', form_id: 'form' };
  return {
    form: [{ id: 'form', tenant_id: 'tenant', name: 'Feedback', form_type: 'survey', survey_settings: { current_version: 1 } }],
    event_survey_assignment: [{ ...scoped, id: 'assignment', event_type: type,
      [type === 'event' ? 'event_id' : 'complex_event_id']: 'event', survey_version_id: 'version', status: 'archived' }],
    [type]: [{ id: 'event', tenant_id: 'tenant', title: 'Conference' }],
    survey_version: [{ ...scoped, id: 'version', version_number: 1, survey_settings: settings }],
    form_submission: [{ ...scoped, id: 'response', survey_assignment_id: 'assignment', survey_version_id: 'version', submitted_by_email: ' YES@example.com ', is_anonymous: false }],
    [type === 'event' ? 'booking' : 'complex_event_booking']: [
      { id: '1', tenant_id: 'tenant', event_id: 'event', status: 'confirmed', attendee_email: 'yes@example.com' },
      { id: '2', tenant_id: 'tenant', event_id: 'event', status: 'confirmed', attendee_email: 'no@example.com' },
      { id: '3', tenant_id: 'tenant', event_id: 'event', status: 'confirmed', attendee_email: 'YES@example.com' },
      { id: '4', tenant_id: 'tenant', event_id: 'event', status: 'cancelled', attendee_email: 'cancelled@example.com' },
      { id: '5', tenant_id: 'tenant', event_id: 'event', status: 'confirmed', member_id: 'purchaser' },
      { id: '6', tenant_id: 'other', event_id: 'event', status: 'confirmed', attendee_email: 'cross@example.com' },
    ],
  };
}
for (const type of ['event', 'complex_event']) {
  test(`${type}: archived reusable survey, both filters, dedup, cancelled and purchaser exclusion`, async () => {
    const tables = fixture(type);
    const db = database(tables);
    assert.deepEqual((await resolveEventSurveyAudience(db, 'tenant', segment)).map(r => r.email), ['yes@example.com']);
    assert.deepEqual((await resolveEventSurveyAudience(db, 'tenant', { ...segment, received: false })).map(r => r.email), ['no@example.com']);
    assert.ok(!db.calls.some(c => c.table === (type === 'event' ? 'complex_event_booking' : 'booking')));
    assert.ok(db.calls.every(c => c.filters.some(([key, value]) => key === 'tenant_id' && value === 'tenant')));
  });
}
test('other assignments of the same survey never count, and surveys on the same event are independent', async () => {
  const tables = fixture();
  tables.event_survey_assignment.push({ ...tables.event_survey_assignment[0], id: 'second' });
  tables.form_submission.push({ ...tables.form_submission[0], id: 'second-response', survey_assignment_id: 'second', submitted_by_email: 'no@example.com' });
  for (const [id, responded, unresponded] of [['assignment', 'yes@example.com', 'no@example.com'], ['second', 'no@example.com', 'yes@example.com']]) {
    for (const received of [true, false]) {
      const recipients = await resolveEventSurveyAudience(database(tables), 'tenant', { ...segment, survey_assignment_id: id, received });
      assert.deepEqual(recipients.map(r => r.email), [received ? responded : unresponded]);
    }
  }
  tables.form.push({ ...tables.form[0], id: 'other-form' });
  tables.survey_version.push({ ...tables.survey_version[0], id: 'other-version', form_id: 'other-form' });
  tables.event_survey_assignment.push({ ...tables.event_survey_assignment[0], id: 'other-survey', form_id: 'other-form', survey_version_id: 'other-version' });
  const other = { ...segment, form_id: 'other-form', survey_assignment_id: 'other-survey' };
  assert.equal((await resolveEventSurveyAudience(database(tables), 'tenant', other)).length, 0);
  assert.equal((await resolveEventSurveyAudience(database(tables), 'tenant', { ...other, received: false })).length, 2);
});
test('enhanced anonymous Responded uses only ledger identities while No response requires complete evidence', async () => {
  const tables = fixture('event', { response_identity: 'anonymous', anonymous_completion_version: 1 });
  tables.form_submission[0].is_anonymous = true;
  tables.survey_completion = [
    { id: 'completion', tenant_id: 'tenant', form_id: 'form', assignment_id: 'assignment', recipient_email: 'no@example.com' },
    { id: 'wrong', tenant_id: 'tenant', form_id: 'form', assignment_id: 'other', recipient_email: 'yes@example.com' },
  ];
  const db = database(tables);
  assert.deepEqual((await resolveEventSurveyAudience(db, 'tenant', segment)).map(row => row.email), ['no@example.com']);
  await assert.rejects(resolveEventSurveyAudience(db, 'tenant', { ...segment, received: false }), /completeness guarantee/);
  assert.ok(db.calls.filter(c => c.table === 'form_submission').every(c => !/submitted_by|submission_data|member_id/.test(c.columns)));
});
test('mixed identity-backed/public anonymous and repeated or mixed-version answers never broaden No response', async () => {
  for (const variant of ['unidentified', 'repeat', 'mixed-version', 'equal-count']) {
    const tables = fixture('event', { response_identity: 'anonymous', anonymous_completion_version: 1 });
    tables.form_submission[0].is_anonymous = true;
    tables.form_submission.push({ ...tables.form_submission[0], id: 'unidentifiable', submitted_by_email: null });
    tables.survey_completion = [{ id: 'known', tenant_id: 'tenant', form_id: 'form', assignment_id: 'assignment', recipient_email: 'yes@example.com' }];
    if (variant === 'mixed-version') {
      tables.survey_version.push({ ...tables.survey_version[0], id: 'another-version', version_number: 2 });
      tables.form_submission[1].survey_version_id = 'another-version';
    }
    if (variant === 'equal-count') {
      // An extra ledger identity cannot establish which historical responses
      // were attributable, even when totals happen to match.
      tables.survey_completion.push({ ...tables.survey_completion[0], id: 'extra', recipient_email: 'other@example.com' });
    }
    assert.deepEqual((await resolveEventSurveyAudience(database(tables), 'tenant', segment)).map(row => row.email), ['yes@example.com']);
    await validateSurveyAudienceSegments(database(tables), 'tenant', [segment]);
    await assert.rejects(resolveEventSurveyAudience(database(tables), 'tenant', { ...segment, received: false }), /completeness guarantee/);
    await assert.rejects(validateSurveyAudienceSegments(database(tables), 'tenant', [{ ...segment, received: false }]), /completeness guarantee/);
  }
});
test('enhanced anonymous empty history remains selectable, but missing ledger storage fails closed', async () => {
  const tables = fixture('event', { response_identity: 'anonymous', anonymous_completion_version: 1 });
  tables.form_submission = [];
  assert.equal((await resolveEventSurveyAudience(database(tables), 'tenant', segment)).length, 0);
  assert.equal((await resolveEventSurveyAudience(database(tables), 'tenant', { ...segment, received: false })).length, 2);
  await assert.rejects(resolveEventSurveyAudience(database(tables, { survey_completion: new Error('unavailable') }), 'tenant', segment));
});
test('historical legacy anonymous, missing versions and missing identified evidence are unsupported', async () => {
  for (const modify of [
    t => { t.survey_version[0].survey_settings = { response_identity: 'anonymous' }; },
    t => { t.form_submission[0].survey_version_id = 'deleted'; },
    t => { t.form_submission[0].submitted_by_email = null; },
    t => { t.form_submission[0].is_anonymous = true; },
    t => { t.event_survey_assignment[0].survey_version_id = null; },
    t => {
      t.form[0].survey_settings.current_version = 2;
      t.survey_version.push({ ...t.survey_version[0], id: 'new', version_number: 2 });
      t.survey_version[0].survey_settings = { response_identity: 'anonymous' };
    },
  ]) {
    const tables = fixture(); modify(tables);
    await assert.rejects(resolveEventSurveyAudience(database(tables), 'tenant', { ...segment, received: false }));
    await assert.rejects(validateSurveyAudienceSegments(database(tables), 'tenant', [segment]));
  }
});
test('archived assignments retain usable historical policy after the reusable survey changes', async () => {
  const tables = fixture();
  tables.form[0].survey_settings.current_version = 2;
  tables.survey_version.push({ ...tables.survey_version[0], id: 'new', version_number: 2, survey_settings: { response_identity: 'anonymous' } });
  assert.equal((await resolveEventSurveyAudience(database(tables), 'tenant', segment)).length, 1);
  tables.event_survey_assignment[0].status = 'active';
  await assert.rejects(resolveEventSurveyAudience(database(tables), 'tenant', segment), /Unsupported survey/);
});
test('missing anonymous ledger evidence cannot classify all attendees as nonrespondents', async () => {
  const tables = fixture('event', { response_identity: 'anonymous', anonymous_completion_version: 1 });
  tables.form_submission[0].is_anonymous = true;
  await assert.rejects(resolveEventSurveyAudience(database(tables), 'tenant', { ...segment, received: false }), /completion evidence is missing/);
});
test('scope validation rejects missing, stale, cross-tenant, conflicting event/form/assignment and malformed choices', async () => {
  for (const change of [
    { survey_assignment_id: null }, { survey_assignment_id: 'stale' }, { form_id: 'other' },
    { event_id: 'other' }, { event_type: 'complex_event' }, { received: 'false' },
    { ids: ['other'] }, { assignment_id: 'other' },
  ]) {
    await assert.rejects(resolveEventSurveyAudience(database(fixture()), 'tenant', { ...segment, ...change }));
  }
  await assert.rejects(resolveEventSurveyAudience(database(fixture()), 'other', segment));
  const tables = fixture(); tables.event = [];
  await assert.rejects(resolveEventSurveyAudience(database(tables), 'tenant', segment), /missing or inaccessible/);
});
test('every query failure fails closed for No response and save validation', async () => {
  for (const table of ['form', 'event_survey_assignment', 'event', 'survey_version', 'form_submission', 'booking']) {
    await assert.rejects(resolveEventSurveyAudience(database(fixture(), { [table]: new Error('unavailable') }), 'tenant', { ...segment, received: false }));
  }
  const tables = fixture('event', { response_identity: 'anonymous', anonymous_completion_version: 1 });
  await assert.rejects(resolveEventSurveyAudience(database(tables, { survey_completion: new Error('unavailable') }), 'tenant', { ...segment, received: false }));
});
test('bookings and scoped response evidence page past 1000 with stable id ordering', async () => {
  const tables = fixture();
  tables.booking = Array.from({ length: 1005 }, (_, i) => ({ ...tables.booking[0], id: String(i), attendee_email: `p${i}@example.com` }));
  tables.form_submission = Array.from({ length: 1001 }, (_, i) => ({ ...tables.form_submission[0], id: String(i), submitted_by_email: `p${i}@example.com` }));
  const db = database(tables);
  assert.equal((await resolveEventSurveyAudience(db, 'tenant', segment)).length, 1001);
  assert.equal((await resolveEventSurveyAudience(db, 'tenant', { ...segment, received: false })).length, 4);
  assert.ok(db.calls.filter(c => c.start != null).every(c => c.order === 'id'));
  assert.ok(db.calls.some(c => c.table === 'booking' && c.start === 1000));
});
test('ordinary event forms retain their existing path and cannot masquerade as assignment surveys', async () => {
  const tables = fixture(); tables.form[0].form_type = 'standard';
  const ordinary = { type: 'event_form', ids: ['form'], received: false };
  const db = database(tables);
  assert.equal(await resolveEventSurveyAudience(db, 'tenant', ordinary), null);
  assert.equal(db.calls.length, 1);
  await validateSurveyAudienceSegments(db, 'tenant', [ordinary]);
  await assert.rejects(resolveEventSurveyAudience(db, 'tenant', segment), /requires a survey/);
});