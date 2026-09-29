import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { prepareCpdEmail } from './eventCpdEmail.js';
import { sendEmail } from './emailService.js';
import surveyAssignmentHandler from '../public/survey-assignment/[token].js';
import { mergeSurveyInvitationPrefill } from '../../shared/surveyInvitationPrefill.js';
import {
  certificateSurveyTokenHash, prepareCertificateSurveyLinks,
  resolveCertificateSurveyGrant, resolveCertificateSurveyGrantState, setCertificateSurveyGrantsDelivery,
} from './certificateSurveyGrants.js';

const tenant = { id: 'tenant-1', slug: 'tests', domain: 'tests.example.org' };
const assignment = {
  id: 'assignment-1', tenant_id: tenant.id, event_type: 'event', event_id: 'event-1',
  token: 'shared-token', form_id: 'form-1', status: 'active', access_mode: 'authenticated',
  closes_at: '2099-04-15T00:00:00Z',
};
const booking = {
  id: 'booking-1', tenant_id: tenant.id, event_id: 'event-1', status: 'confirmed',
  attendee_email: 'guest@example.org', attendee_first_name: 'Guest',
};
const form = {
  id: 'form-1', tenant_id: tenant.id, name: '<Important survey>', description: 'Please > respond',
  form_type: 'survey', is_active: true, survey_settings: { status: 'published', current_version: 1 },
};
function dbFixture() {
  const rows = {
    booking: [structuredClone(booking)],
    event_survey_assignment: [structuredClone(assignment)],
    form: [structuredClone(form)],
    certificate_survey_entitlement: [],
    certificate_survey_credential: [],
    survey_invitation_attendee: [],
    attendee_cpd_certificate_delivery: [],
  };
  const writes = [];
  return {
    rows, writes,
    from(table) {
      const clauses = [];
      let start = 0;
      let end = Infinity;
      let operation = null;
      let input = null;
      const query = {
        select() { return query; },
        eq(key, value) { clauses.push(row => row[key] === value); return query; },
        in(key, values) { clauses.push(row => values.includes(row[key])); return query; },
        update(value) { operation = 'update'; input = value; return query; },
        order() { return query; },
        range(from, to) { start = from; end = to + 1; return query; },
        maybeSingle() { return Promise.resolve({ data: rows[table].find(row => clauses.every(f => f(row))) || null }); },
        single() {
          if (operation === 'insert') {
            const row = { id: `id-${writes.length + 1}`, ...input };
            rows[table].push(row);
            writes.push({ table, row });
            return Promise.resolve({ data: row });
          }
          return query.maybeSingle();
        },
        insert(value) { operation = 'insert'; input = value; return query; },
      };
      query.then = (resolve, reject) => {
        const matches = rows[table].filter(row => clauses.every(f => f(row))).slice(start, end);
        if (operation === 'update') matches.forEach(row => Object.assign(row, input));
        return Promise.resolve({ data: matches }).then(resolve, reject);
      };
      return query;
    },
  };
}

test('preview lists eligible surveys without issuing a credential or leaking markup', async () => {
  const db = dbFixture();
  assert.equal((await db.from('event_survey_assignment').select('*').eq('tenant_id', tenant.id)
    .eq('event_id', 'event-1').eq('event_type', 'event').eq('status', 'active')).data.length, 1);
  const list = await prepareCertificateSurveyLinks({
    db, tenant, eventType: 'event', eventId: 'event-1',
    bookingSource: 'standard', bookingId: 'booking-1',
    recipient: 'guest@example.org', preview: true,
  });
  assert.equal(db.writes.length, 0);
  assert.match(list.html, /&lt;Important survey&gt;/);
  assert.doesNotMatch(list.html, /href=/);
  assert.match(list.text, /Please > respond/);
  db.rows.certificate_survey_entitlement.push({
    tenant_id: tenant.id, assignment_id: assignment.id,
    booking_source: 'standard', booking_id: booking.id, completed_at: '2026-01-01',
  });
  const completed = await prepareCertificateSurveyLinks({
    db, tenant, eventType: 'event', eventId: 'event-1',
    bookingSource: 'standard', bookingId: 'booking-1', recipient: 'guest@example.org', preview: true,
  });
  assert.match(completed.text, /Response received/);
  assert.equal(db.writes.length, 0);
  db.rows.event_survey_assignment[0].status = 'archived';
  const empty = await prepareCertificateSurveyLinks({
    db, tenant, eventType: 'event', eventId: 'event-1',
    bookingSource: 'standard', bookingId: 'booking-1', recipient: 'guest@example.org',
  });
  assert.equal(empty.grantIds.length, 0);
  assert.match(empty.text, /No surveys/);
});

test('issuance requires confirmed booking and creates a hashed per-booking credential', async () => {
  const db = dbFixture();
  const deliveryId = '11111111-1111-4111-8111-111111111111';
  db.rows.booking[0].status = 'cancelled';
  await assert.rejects(prepareCertificateSurveyLinks({
    db, tenant, eventType: 'event', eventId: 'event-1', bookingSource: 'standard',
    bookingId: 'booking-1', recipient: 'guest@example.org', preview: false, deliveryId,
  }), /confirmed booking/);
  assert.equal(db.writes.length, 0);
  db.rows.booking[0].status = 'confirmed';
  const list = await prepareCertificateSurveyLinks({
    db, tenant, eventType: 'event', eventId: 'event-1', bookingSource: 'standard',
    bookingId: 'booking-1', recipient: 'guest@example.org', preview: false, deliveryId,
  });
  assert.equal(list.grantIds.length, 1);
  assert.match(list.text, /https:\/\/tests\.example\.org\/survey\/shared-token#certificate_grant=[A-Za-z0-9_-]{43}/);
  assert.equal(db.rows.certificate_survey_credential[0].token_hash.length, 64);
  assert.equal(db.rows.certificate_survey_credential[0].delivery_id, deliveryId);
  assert.doesNotMatch(JSON.stringify(db.writes), /certificate_grant=/);
  const token = list.text.match(/certificate_grant=([A-Za-z0-9_-]{43})/)[1];
  assert.equal(certificateSurveyTokenHash(token), db.rows.certificate_survey_credential[0].token_hash);
});

test('logged-out assignment GET serves accepted grant and rejects invalid, expired and wrong-assignment grants', async () => {
  const db = dbFixture();
  db.rows.event = [];
  db.rows.survey_version = [{
    form_id: form.id, tenant_id: tenant.id, version_number: 1,
    fields: [
      { id: 'feedback', type: 'text', label: 'Feedback' },
      { id: 'first', type: 'text', prefill_field: 'member:first_name' },
      { id: 'last', type: 'text', prefill_field: 'booking:attendee_last_name' },
      { id: 'email', type: 'email', prefill_field: 'member:email' },
      { id: 'org', type: 'text', prefill_field: 'org:name' },
      { id: 'private', type: 'text', prefill_field: 'member_custom:private-field' },
    ], pages: [],
  }];
  Object.assign(db.rows.booking[0], {
    attendee_last_name: 'Attendee', member_id: 'other-booker',
    organization_id: 'other-organization',
  });
  db.rows.form[0].fields = [{ id: 'unpublished', prefill_field: 'booking:attendee_email' }];
  const deliveryId = '11111111-1111-4111-8111-111111111111';
  const links = await prepareCertificateSurveyLinks({
    db, tenant, eventType: 'event', eventId: 'event-1', bookingSource: 'standard',
    bookingId: booking.id, recipient: booking.attendee_email, preview: false, deliveryId,
  });
  const token = links.text.match(/certificate_grant=([A-Za-z0-9_-]{43})/)[1];
  db.rows.attendee_cpd_certificate_delivery.push({
    id: deliveryId, tenant_id: tenant.id, booking_source: 'standard',
    booking_id: booking.id, status: 'accepted', purpose: 'test',
  });
  const invoke = async supplied => {
    const output = {};
    const res = { setHeader() {}, status(code) { output.status = code; return res; },
      json(body) { output.body = body; return res; } };
    await surveyAssignmentHandler({ method: 'GET', query: { token: assignment.token },
      headers: supplied ? { 'x-certificate-survey-grant': supplied } : {} }, res, {
      supabase: db, resolveTenant: async () => tenant,
      getSessionMember: async () => null, getSession: async () => null,
    });
    return output;
  };
  const allowed = await invoke(token);
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.form.id, form.id);
  assert.equal(allowed.body.require_authentication, undefined);
  assert.deepEqual(allowed.body.invitation_prefill.values, {
    first: 'Guest', last: 'Attendee', email: 'guest@example.org',
  });
  assert.deepEqual(allowed.body.invitation_prefill.unavailable.map(item => item.field_id), ['org', 'private']);
  assert.deepEqual(mergeSurveyInvitationPrefill(
    { feedback: 'Draft feedback' }, allowed.body.invitation_prefill, allowed.body.form.fields,
  ), { feedback: 'Draft feedback', first: 'Guest', last: 'Attendee', email: 'guest@example.org' });
  // Exercise the GET payload through the same client initializer into actual
  // rendered inputs, without a browser request, bearer URL, or real submission.
  const dom = new JSDOM('<div id="root"></div>');
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousAct = globalThis.IS_REACT_ACT_ENVIRONMENT;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(dom.window.document.getElementById('root'));
  try {
    const values = mergeSurveyInvitationPrefill({}, allowed.body.invitation_prefill, allowed.body.form.fields);
    await act(async () => root.render(React.createElement('form', null,
      allowed.body.form.fields.map(field => React.createElement('input', {
        key: field.id, name: field.id, value: values[field.id] || '', readOnly: true,
      })))));
    assert.equal(dom.window.document.querySelector('[name="first"]').value, 'Guest');
    assert.equal(dom.window.document.querySelector('[name="last"]').value, 'Attendee');
    assert.equal(dom.window.document.querySelector('[name="email"]').value, 'guest@example.org');
    assert.equal(dom.window.document.querySelector('[name="org"]').value, '');
  } finally {
    await act(async () => root.unmount());
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    globalThis.IS_REACT_ACT_ENVIRONMENT = previousAct;
    dom.window.close();
  }
  assert.equal(JSON.stringify(allowed.body.invitation_prefill).includes('other-booker'), false);
  const originalTenant = db.rows.booking[0].tenant_id;
  db.rows.booking[0].tenant_id = 'other-tenant';
  assert.equal((await invoke(token)).status, 403);
  db.rows.booking[0].tenant_id = originalTenant;
  db.rows.booking[0].status = 'cancelled';
  assert.equal((await invoke(token)).status, 403);
  db.rows.booking[0].status = 'confirmed';
  const ordinary = await invoke(null);
  assert.equal(ordinary.body.require_authentication, true);
  assert.equal(ordinary.body.form, undefined);
  assert.equal((await invoke('invalid')).status, 403);
  const grant = db.rows.certificate_survey_entitlement[0];
  grant.assignment_id = 'wrong-assignment';
  assert.equal((await invoke(token)).status, 403);
  grant.assignment_id = assignment.id;
  db.rows.certificate_survey_credential[0].expires_at = '2000-01-01T00:00:00Z';
  assert.equal((await invoke(token)).status, 403);
});

test('two published assignments both appear in the final wrapped email, with buttons in padded separate rows', async () => {
  const db = dbFixture();
  db.rows.event_survey_assignment.push({
    ...assignment, id: 'assignment-2', form_id: 'form-2', token: 'second-token',
  });
  db.rows.form.push({
    ...form, id: 'form-2', name: 'Second survey', description: 'Second description',
  });
  const list = await prepareCertificateSurveyLinks({
    db, tenant, eventType: 'event', eventId: 'event-1', bookingSource: 'standard',
    bookingId: 'booking-1', recipient: 'guest@example.org', preview: false,
    deliveryId: '11111111-1111-4111-8111-111111111111',
  });
  assert.equal(list.snapshot.length, 2);
  assert.equal(list.grantIds.length, 2);
  assert.equal(db.rows.certificate_survey_credential.length, 2);
  db.rows.tenant = [{ id: tenant.id, settings: {} }];
  const email = await prepareCpdEmail(db, tenant.id, {
    template: { id: 'template-1', name: 'Certificate', subject: 'Certificate',
      body: '<table><tbody><tr><td><div style="font-size:14px">{{event_survey_list}}</div></td></tr></tbody></table>' },
  }, {}, list);
  // prepareCpdEmail reads the tenant before rendering; its actual wrapper is
  // included in the HTML passed through the transport, not just helper output.
  let delivered;
  const result = await sendEmail({
    ...email.message, to: 'guest@example.org', tenantId: tenant.id,
    disableTracking: true, includeRenderedContent: true,
  }, {
    client: { messages: { create: async (_domain, message) => {
      delivered = message;
      return { id: '<fixture@example.org>' };
    } } },
    getTenantEmailConfig: async () => null,
    getEmailFooter: async () => '<p>Footer</p>',
    replaceSocialPlaceholdersInFooter: async html => html,
    resolveTransactionalPreferenceTokens: async payload => payload,
  });
  assert.equal(result.success, true);
  assert.equal(result.renderedHtml, delivered.html);
  const document = new JSDOM(result.renderedHtml).window.document;
  const cards = [...document.querySelectorAll('table[role="presentation"]')]
    .filter(table => table.textContent.includes('Complete survey') && table.querySelectorAll('a[href*="certificate_grant"]').length);
  assert.equal(document.querySelectorAll('a[href*="certificate_grant"]').length, 2);
  for (const title of ['<Important survey>', 'Second survey']) {
    const card = cards.find(table => table.textContent.includes(title) && table.querySelector('td[style*="font-weight:bold"]'));
    assert.ok(card, `${title} card exists after wrapping`);
    const titleCell = card.querySelector('td[style*="font-weight:bold"]');
    const buttonCell = card.querySelector('td[style*="padding:8px 16px 16px"]');
    assert.ok(buttonCell);
    assert.notEqual(titleCell.parentElement, buttonCell.parentElement);
    assert.ok(buttonCell.querySelector('a[href*="certificate_grant"]'));
  }
  assert.match(delivered.html, /Second description/);
  assert.match(delivered.html, /Closing date:/);
  assert.equal(delivered['o:tracking-clicks'], 'no');
});

test('admin preview explains excluded assignments without leaking them into message or issuing grants', async () => {
  const db = dbFixture();
  db.rows.event_survey_assignment.push(
    { ...assignment, id: 'draft', form_id: 'draft-form' },
    { ...assignment, id: 'future', form_id: 'future-form', opens_at: '2099-01-01T00:00:00Z' },
    { ...assignment, id: 'inactive', form_id: 'inactive-form' },
    { ...assignment, id: 'expired', form_id: 'expired-form' },
    { ...assignment, id: 'unversioned', form_id: 'unversioned-form' },
  );
  db.rows.form.push(
    { ...form, id: 'draft-form', name: 'Autumn Meeting Feedback', survey_settings: { status: 'draft' } },
    { ...form, id: 'future-form', name: 'Future' },
    { ...form, id: 'inactive-form', name: 'Inactive', is_active: false },
    { ...form, id: 'expired-form', name: 'Expired', deactivate_at: '2020-01-01T00:00:00Z' },
    { ...form, id: 'unversioned-form', name: 'Unversioned', survey_settings: { status: 'published' } },
  );
  const opts = { db, tenant, eventType: 'event', eventId: 'event-1',
    bookingSource: 'standard', bookingId: 'booking-1', recipient: 'guest@example.org' };
  const preview = await prepareCertificateSurveyLinks({ ...opts, preview: true });
  assert.equal(preview.snapshot.length, 1);
  assert.deepEqual(preview.omitted.map(({ title, reason }) => [title, reason]), [
    ['Autumn Meeting Feedback', 'Survey is not published.'],
    ['Future', 'Assignment has not opened.'],
    ['Inactive', 'Survey form is inactive.'],
    ['Expired', 'Survey form availability window has closed.'],
    ['Unversioned', 'Survey has no published version.'],
  ]);
  assert.doesNotMatch(preview.html + preview.text, /Autumn Meeting Feedback/);
  assert.equal(db.writes.length, 0);
  const sent = await prepareCertificateSurveyLinks({ ...opts, preview: false,
    deliveryId: '11111111-1111-4111-8111-111111111111' });
  assert.equal(sent.snapshot.length, 1);
  assert.equal(sent.grantIds.length, 1);
  assert.equal(sent.omitted, undefined);
  assert.doesNotMatch(sent.html + sent.text, /Autumn Meeting Feedback/);
});

test('complex bookings use the actual event_id booking column against complex assignment scope', async () => {
  const db = dbFixture();
  db.rows.complex_event_booking = [{ ...booking }];
  db.rows.event_survey_assignment[0] = {
    ...assignment, event_type: 'complex_event', event_id: null, complex_event_id: 'event-1',
  };
  const list = await prepareCertificateSurveyLinks({
    db, tenant, eventType: 'complex_event', eventId: 'event-1',
    bookingSource: 'complex', bookingId: 'booking-1',
    recipient: 'guest@example.org', preview: true,
  });
  assert.match(list.text, /Important survey/);
  const token = 'c'.repeat(43);
  db.rows.certificate_survey_entitlement.push({
    id: 'entitlement-complex', tenant_id: tenant.id, assignment_id: assignment.id,
    booking_source: 'complex', booking_id: booking.id, recipient_email: 'guest@example.org',
    expires_at: '2099-04-15T00:00:00Z',
  });
  db.rows.certificate_survey_credential.push({
    id: 'credential-complex', entitlement_id: 'entitlement-complex', delivery_id: 'delivery-complex',
    token_hash: certificateSurveyTokenHash(token), expires_at: '2099-04-15T00:00:00Z',
  });
  db.rows.attendee_cpd_certificate_delivery.push({
    id: 'delivery-complex', tenant_id: tenant.id, booking_source: 'complex',
    booking_id: booking.id, status: 'accepted',
  });
  assert.equal((await resolveCertificateSurveyGrant(db, tenant.id,
    db.rows.event_survey_assignment[0], token))?.booking.event_id, 'event-1');
});

test('known failure revokes credentials; acceptance uses durable delivery ledger without another write', async () => {
  const db = dbFixture();
  db.rows.certificate_survey_credential.push({ id: 'a' }, { id: 'b' });
  await setCertificateSurveyGrantsDelivery({ db, grantIds: ['a'], status: 'accepted' });
  assert.equal(db.rows.certificate_survey_credential[0].revoked_at, undefined);
  await setCertificateSurveyGrantsDelivery({ db, grantIds: ['b'], status: 'failed' });
  assert.ok(db.rows.certificate_survey_credential[1].revoked_at);
  await assert.rejects(setCertificateSurveyGrantsDelivery({ db, grantIds: ['b'], status: 'unknown' }), /Invalid/);
});

test('resolution fails closed across assignment, booking, tenant, delivery and completion', async () => {
  const token = 'a'.repeat(43);
  const db = dbFixture();
  db.rows.certificate_survey_entitlement.push({
    id: 'entitlement-1', assignment_id: assignment.id, tenant_id: tenant.id,
    booking_id: booking.id, booking_source: 'standard', recipient_email: 'guest@example.org',
    expires_at: '2099-04-15T00:00:00Z',
  });
  db.rows.certificate_survey_credential.push({
    id: 'credential-1', entitlement_id: 'entitlement-1', delivery_id: 'delivery-1',
    token_hash: certificateSurveyTokenHash(token),
    expires_at: '2099-04-15T00:00:00Z',
  });
  assert.equal(await resolveCertificateSurveyGrant(db, tenant.id, assignment, token), null);
  db.rows.attendee_cpd_certificate_delivery.push({
    id: 'delivery-1', tenant_id: tenant.id, booking_source: 'standard',
    booking_id: booking.id, status: 'pending',
  });
  assert.equal(await resolveCertificateSurveyGrant(db, tenant.id, assignment, token), null);
  db.rows.attendee_cpd_certificate_delivery[0].status = 'accepted';
  assert.ok(await resolveCertificateSurveyGrant(db, tenant.id, assignment, token));
  assert.equal(await resolveCertificateSurveyGrant(db, 'other', assignment, token), null);
  assert.equal(await resolveCertificateSurveyGrant(db, tenant.id, { ...assignment, id: 'other' }, token), null);
  db.rows.booking[0].attendee_email = 'another@example.org';
  assert.equal(await resolveCertificateSurveyGrant(db, tenant.id, assignment, token), null);
  db.rows.booking[0].attendee_email = 'guest@example.org';
  db.rows.certificate_survey_entitlement[0].completed_at = '2026-01-01';
  assert.equal(await resolveCertificateSurveyGrant(db, tenant.id, assignment, token), null);
  assert.equal((await resolveCertificateSurveyGrantState(db, tenant.id, assignment, token))?.status, 'completed');
});

test('completed bearer returns already-received page even after survey form is disabled; wrong session denied', async () => {
  const token = 'b'.repeat(43);
  const db = dbFixture();
  db.rows.event_survey_assignment[0].status = 'archived';
  db.rows.form[0].is_active = false;
  db.rows.certificate_survey_entitlement.push({
    id: 'entitlement-1', tenant_id: tenant.id, assignment_id: assignment.id,
    booking_id: booking.id, booking_source: 'standard', recipient_email: 'guest@example.org',
    completed_at: '2026-01-01T00:00:00Z', response_id: 'private-response-id',
    expires_at: '2099-04-15T00:00:00Z',
  });
  db.rows.certificate_survey_credential.push({
    entitlement_id: 'entitlement-1', delivery_id: 'delivery-1',
    token_hash: certificateSurveyTokenHash(token), expires_at: '2099-04-15T00:00:00Z',
  });
  db.rows.attendee_cpd_certificate_delivery.push({
    id: 'delivery-1', tenant_id: tenant.id, booking_source: 'standard',
    booking_id: booking.id, status: 'accepted',
  });
  const invoke = async (getSessionMember, getSession) => {
    const output = { status: 200, headers: {} };
    const res = { setHeader(k, v) { output.headers[k] = v; },
      status(code) { output.status = code; return res; },
      json(body) { output.body = body; return res; } };
    await surveyAssignmentHandler({ method: 'GET', query: { token: assignment.token },
      headers: { 'x-certificate-survey-grant': token } }, res, {
      supabase: db, resolveTenant: async () => tenant,
      getSessionMember, getSession,
    });
    return output;
  };
  const completed = await invoke(async () => null, async () => null);
  assert.equal(completed.status, 200);
  assert.equal(completed.body.invitation_completed, true);
  assert.match(completed.body.closed_message, /already been received/);
  assert.doesNotMatch(JSON.stringify(completed.body), /guest@example|private-response-id|entitlement-1/);
  const wrongSession = await invoke(async () => ({
    tenant_id: tenant.id, email: 'wrong@example.org',
  }), async () => ({ id: 'session' }));
  assert.equal(wrongSession.status, 403);
});

test('SQL enforces transactional locked completion, scope and role lockdown', () => {
  const sql = readFileSync(new URL('../../supabase/migrations/20261121_certificate_survey_grants.sql', import.meta.url), 'utf8');
  assert.match(sql, /FOR UPDATE/);
  assert.match(sql, /FOR SHARE/);
  assert.match(sql, /create_survey_submission\(p_submission, p_answers\)/);
  assert.match(sql, /completed_at = now\(\), response_id = v_row\.id/);
  assert.match(sql, /OLD\.completed_at IS NOT NULL AND NEW\.completed_at IS DISTINCT FROM OLD\.completed_at/);
  assert.match(sql, /OLD\.revoked_at IS NOT NULL AND NEW\.revoked_at IS DISTINCT FROM OLD\.revoked_at/);
  assert.match(sql, /d\.status = 'accepted'/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.create_certificate_survey_submission/);
  assert.match(sql, /response_id uuid UNIQUE REFERENCES public\.form_submission/);
});

test('invitation remains confined to assignment routes and disappears before analytics starts', () => {
  const page = readFileSync(new URL('../../client/index.html', import.meta.url), 'utf8');
  const formView = readFileSync(new URL('../../client/src/pages/FormView.jsx', import.meta.url), 'utf8');
  const slugRoute = readFileSync(new URL('../public/form/[slug].js', import.meta.url), 'utf8');
  assert.ok(page.indexOf("location.hash.startsWith('#certificate_grant=')") < page.indexOf('type="module"'));
  assert.match(page, /history\.replaceState\(history\.state/);
  assert.match(page, /name="referrer" content="no-referrer"/);
  assert.match(formView, /certificate_survey_grant: certificateGrant/);
  assert.match(formView, /getSurveyAssignment\(assignmentToken, certificateGrant\)/);
  assert.doesNotMatch(slugRoute, /certificate_survey_grant/);
  const submission = readFileSync(new URL('../public/form-submission.js', import.meta.url), 'utf8');
  assert.match(submission, /resolveCertificateSurveyGrant/);
  assert.match(submission, /create_certificate_survey_submission/);
  assert.match(submission, /certificateInvitation\?\.grant\.recipient_email \|\| sessionMemberEmail/);
});

test('head strips fragment but keeps per-tab capability through refresh and resets completed marker for a new invitation', () => {
  const page = readFileSync(new URL('../../client/index.html', import.meta.url), 'utf8');
  const script = page.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  const token = 'a'.repeat(43);
  const storage = new Map([['certificate-survey-completed:/survey/shared', '1']]);
  const location = { pathname: '/survey/shared', search: '', hash: `#certificate_grant=${token}` };
  const sessionStorage = {
    getItem: key => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: key => storage.delete(key),
  };
  runInNewContext(script, {
    location, sessionStorage, history: {
      state: null, replaceState() { location.hash = ''; },
    },
  });
  assert.equal(location.hash, '');
  assert.equal(storage.get('certificate-survey:/survey/shared'), token);
  assert.equal(storage.has('certificate-survey-completed:/survey/shared'), false);
  runInNewContext(script, { location, sessionStorage, history: { state: null, replaceState() {} } });
  assert.equal(storage.get('certificate-survey:/survey/shared'), token);
  assert.equal(new Map().get('certificate-survey:/survey/shared'), undefined);
  const formView = readFileSync(new URL('../../client/src/pages/FormView.jsx', import.meta.url), 'utf8');
  const initializer = formView.slice(formView.indexOf('const [certificateGrant]'), formView.indexOf('const {', formView.indexOf('const [certificateGrant]')));
  assert.doesNotMatch(initializer, /removeItem/);
  assert.match(formView, /payload\.invitation_completed/);
  assert.match(formView, /certificate-survey-completed:/);
  const route = readFileSync(new URL('../public/survey-assignment/[token].js', import.meta.url), 'utf8');
  assert.match(route, /invitation_completed: true/);
});