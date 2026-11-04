import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRegistrantSurveyEmail, loadRegistrantSurveyEvent, surveyAcceptsResponses } from './registrantSurveyEmail.js';
import { handleRegistrantSurveyEmail } from '../reports/registrant-survey-email.js';

const tenant = '11111111-1111-4111-8111-111111111111';
const event = '22222222-2222-4222-8222-222222222222';
const booking = '33333333-3333-4333-8333-333333333333';
const assignment = '44444444-4444-4444-8444-444444444444';
const request = '55555555-5555-4555-8555-555555555555';
const input = { booking_id: booking, booking_source: 'standard', assignment_id: assignment };
function fixture() {
  const rows = {
    event: [{ id: event, tenant_id: tenant, title: 'Test <Webinar>', is_online: true }],
    complex_event: [], event_agenda_item: [], complex_event_session: [],
    booking: [{ id: booking, event_id: event, tenant_id: tenant, status: 'confirmed', attendee_email: 'guest@example.org', attendee_first_name: '<Guest>' }],
    complex_event_booking: [], complex_event_session_checkin: [],
    attendance_target: [], attendance_current_outcome: [],
    event_survey_assignment: [{ id: assignment, tenant_id: tenant, event_id: event, form_id: 'form', status: 'active', token: 'test-token' }],
    form: [{ id: 'form', tenant_id: tenant, name: 'Feedback', form_type: 'survey', is_active: true, survey_settings: { status: 'published', current_version: 1 } }],
    survey_version: [{ id: 'version', tenant_id: tenant, form_id: 'form', version_number: 1 }],
    tenant: [{ id: tenant, name: 'Test organisation', slug: 'test', domain: null }],
    registrant_survey_delivery: [],
  };
  const failures = new Set();
  const db = { from(table) {
    const filters = []; let one = false, write = null, update = null;
    const q = {
      select() { return q; }, eq(k, v) { filters.push(r => r[k] === v); return q; },
      maybeSingle() { one = true; return q; },
      insert(v) { write = v; return q; }, update(v) { update = v; return q; },
      then(resolve, reject) {
        return Promise.resolve().then(() => {
          if (failures.has(table)) return { error: { message: 'Test storage error' } };
          if (write) {
            if (rows[table].some(r => r.id === write.id || (
              r.tenant_id === write.tenant_id && r.booking_id === write.booking_id
              && r.assignment_id === write.assignment_id && ['pending','unknown'].includes(r.status)))) return { error: { code: '23505' } };
            rows[table].push({ status: 'pending', ...write }); return { data: null };
          }
          const found = rows[table].filter(r => filters.every(f => f(r)));
          if (update) found.forEach(r => Object.assign(r, update));
          return { data: one ? found[0] || null : found };
        }).then(resolve, reject);
      },
    }; return q;
  } };
  return { rows, db, failures };
}

test('untracked confirmed guest preview uses attendee, canonical link, escaped content and no writes', async () => {
  const f = fixture(); const before = JSON.stringify(f.rows);
  const p = await resolveRegistrantSurveyEmail(f.db, tenant, input);
  assert.equal(p.recipient, 'guest@example.org');
  assert.equal(p.attendance_warning, true);
  assert.match(p.html, /&lt;Guest&gt;/);
  assert.match(p.html, /\/survey\/test-token/);
  assert.equal(JSON.stringify(f.rows), before);
  assert.equal(p.fingerprint, (await resolveRegistrantSurveyEmail(f.db, tenant, input)).fingerprint);
});
test('attendance configured before first sync is enforced and errors fail closed', async () => {
  for (const location of ['event','child','target','qr']) {
    const f = fixture();
    if (location === 'event') f.rows.event[0].attendance_tracking_enabled = true;
    if (location === 'child') f.rows.event_agenda_item.push({ event_id: event, tenant_id: tenant, attendance_policy_override: true, attendance_tracking_enabled: true });
    if (location === 'target') f.rows.attendance_target.push({ id: 'target', event_id: event, tenant_id: tenant, tracking_enabled: false });
    if (location === 'qr') f.rows.event[0].is_online = false;
    await assert.rejects(resolveRegistrantSurveyEmail(f.db, tenant, input), /Attendance has not been verified/);
  }
  const f = fixture(); f.failures.add('attendance_target');
  await assert.rejects(resolveRegistrantSurveyEmail(f.db, tenant, input), /could not be verified/);
});
test('only current qualifying provider attendance permits send; QR check-in works too', async () => {
  const f = fixture();
  f.rows.event[0].attendance_tracking_enabled = true;
  f.rows.attendance_target.push({ id: 'target', event_id: event, tenant_id: tenant, tracking_enabled: true });
  const outcome = { tenant_id: tenant, booking_id: booking, booking_type: 'booking', attendance_target_id: 'target', status: 'attended', provider: 'zoom', outcome_revision_id: 'revision' };
  f.rows.attendance_current_outcome.push(outcome);
  assert.equal((await resolveRegistrantSurveyEmail(f.db, tenant, input)).attendance_verified, true);
  for (const status of ['absent', 'pending', 'unmatched', 'below_threshold', 'sync_failed']) {
    outcome.status = status;
    await assert.rejects(resolveRegistrantSurveyEmail(f.db, tenant, input), /Attendance/);
  }
  outcome.status = 'attended'; f.rows.attendance_target[0].tracking_enabled = false;
  await assert.rejects(resolveRegistrantSurveyEmail(f.db, tenant, input), /Attendance/);
  f.rows.booking[0].checked_in_at = '2026-01-01';
  assert.equal((await resolveRegistrantSurveyEmail(f.db, tenant, input)).attendance_verified, true);
});
test('closed, removed, draft, missing publication and foreign-tenant surveys are excluded', async () => {
  const f = fixture();
  assert.equal(surveyAcceptsResponses(f.rows.form[0], f.rows.event_survey_assignment[0], true), true);
  for (const mutate of [
    f => { f.rows.event_survey_assignment[0].closes_at = '2020-01-01'; },
    f => { f.rows.event_survey_assignment[0].opens_at = '2099-01-01'; },
    f => { f.rows.event_survey_assignment[0].status = 'archived'; },
    f => { f.rows.form[0].survey_settings.status = 'draft'; },
    f => { f.rows.survey_version = []; },
    f => { f.rows.form[0].tenant_id = 'other'; },
  ]) {
    const f = fixture(); mutate(f);
    assert.deepEqual((await loadRegistrantSurveyEvent(f.db, tenant, event, 'standard')).surveys, []);
  }
  await assert.rejects(resolveRegistrantSurveyEmail(f.db, 'other', input), /confirmed registrations/);
});
test('complex events enforce session attendance and preserve guest recipient', async () => {
  const f = fixture();
  f.rows.complex_event = f.rows.event;
  f.rows.complex_event_booking = f.rows.booking;
  f.rows.complex_event_session = [{ id: 'session', tenant_id: tenant, complex_event_id: event, is_online: false }];
  f.rows.event_survey_assignment[0].complex_event_id = event;
  const params = { ...input, booking_source: 'complex' };
  await assert.rejects(resolveRegistrantSurveyEmail(f.db, tenant, params), /Attendance/);
  f.rows.complex_event_session_checkin.push({ booking_id: booking, tenant_id: tenant, session_id: 'session', checked_in_at: '2026-01-01' });
  assert.equal((await resolveRegistrantSurveyEmail(f.db, tenant, params)).recipient, 'guest@example.org');
});

async function invoke(f, body, options = {}) {
  const res = { setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  let sends = 0;
  await handleRegistrantSurveyEmail({ method: 'POST', body }, res, {
    db: f.db, contextFor: async () => ({ tenantId: tenant, isAuthenticated: true, memberId: 'admin', roleId: 'role' }),
    adminAccess: async () => true, featureAccess: async () => true,
    send: async () => { sends++; return { success: true, messageId: 'provider-message' }; }, ...options,
  });
  return { ...res, sends };
}
test('API requires preview fingerprint and explicit attendance acknowledgement, and deduplicates sends', async () => {
  const f = fixture();
  const preview = await invoke(f, { ...input, action: 'preview' });
  assert.equal(preview.code, 200); assert.equal(preview.sends, 0);
  const body = { ...input, action: 'send', request_id: request, expected_fingerprint: preview.body.fingerprint, confirmed: true };
  assert.equal((await invoke(f, body)).code, 409);
  body.acknowledge_unverified = true;
  assert.equal((await invoke(f, { ...body, expected_fingerprint: 'stale' })).code, 409);
  const sent = await invoke(f, body);
  assert.equal(sent.code, 200); assert.equal(sent.sends, 1);
  const repeated = await invoke(f, body);
  assert.equal(repeated.code, 200); assert.equal(repeated.sends, 0);
  assert.equal(f.rows.registrant_survey_delivery[0].status, 'accepted');
});
test('permissions, changed recipients and unresolved sends cannot bypass protection', async () => {
  const f = fixture();
  const p = await resolveRegistrantSurveyEmail(f.db, tenant, input);
  const body = { ...input, action: 'send', request_id: request, expected_fingerprint: p.fingerprint, confirmed: true, acknowledge_unverified: true };
  assert.equal((await invoke(f, body, { adminAccess: async () => false })).code, 403);
  assert.equal((await invoke(f, body, { featureAccess: async () => false })).code, 403);
  f.rows.booking[0].attendee_email = 'new@example.org';
  assert.equal((await invoke(f, body)).code, 409);
  f.rows.booking[0].attendee_email = 'guest@example.org';
  const unknown = await invoke(f, body, { send: async () => { throw Error('timeout'); } });
  assert.equal(unknown.code, 503);
  assert.equal(f.rows.registrant_survey_delivery[0].status, 'unknown');
  const retry = await invoke(f, { ...body, request_id: '66666666-6666-4666-8666-666666666666' });
  assert.equal(retry.code, 409); assert.equal(retry.sends, 0);
});
