import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { resolveCampaignAttendeeContent } from './campaignAttendeeContent.js';
import { resolveCampaignEventSurvey, replaceEventSurvey } from './campaignEventSurvey.js';
import { resolveCampaignEventSponsors, replaceEventSponsors } from './eventEmailSponsors.js';
import { isStandaloneCampaignPreferencePlaceholder } from './campaignEmailComposition.js';
import { prepareCampaignSurveyDelivery, finishCampaignSurveyDelivery, replaceCampaignSurveyInvitation } from './campaignSurveyDelivery.js';
import surveyAssignmentHandler from '../public/survey-assignment/[token].js';
import submissionHandler from '../public/form-submission.js';

function fixture() {
  const rows = {
    campaign_survey_delivery: [], certificate_survey_entitlement: [], certificate_survey_credential: [],
    email_campaign_recipient: [], form_submission: [],
    event: [{ id: 'event', tenant_id: 'tenant' }],
    tenant: [{ id: 'tenant', slug: 'fixture', domain: 'fixture.invalid' }],
    booking: [{ id: 'booking', tenant_id: 'tenant', event_id: 'event', status: 'confirmed',
      attendee_first_name: 'Isa & Ann', attendee_last_name: 'Tester', attendee_email: 'isaasitesting2@outlook.com' }],
    event_survey_assignment: [{ id: 'assignment', tenant_id: 'tenant', event_id: 'event', event_type: 'event',
      status: 'active', token: 'existing-assignment-token', form_id: 'form', access_mode: 'authenticated' }],
    form: [{ id: 'form', tenant_id: 'tenant', name: 'Event feedback', is_active: true, form_type: 'survey',
      survey_settings: { status: 'published', current_version: 1 } }],
    survey_version: [{ id: 'version', tenant_id: 'tenant', form_id: 'form', version_number: 1 }],
  };
  const db = { from(table) {
    const filters = [];
    let limit = Infinity;
    let update;
    let insert;
    const q = {
      select() { return q; }, update(value) { update = value; return q; }, eq(k, v) { filters.push(r => r[k] === v); return q; },
      in(k, values) { filters.push(r => values.includes(r[k])); return q; },
      is(k, value) { filters.push(r => (r[k] ?? null) === value); return q; },
      not() { return q; }, neq(k, value) { filters.push(r => r[k] !== value); return q; },
      gte(k, value) { filters.push(r => r[k] >= value); return q; },
      insert(value) { insert = value; return q; },
      ilike(k, v) { filters.push(r => r[k]?.toLowerCase() === v.toLowerCase()); return q; },
      order() { return q; }, limit(n) { limit = n; return q; }, range() { return q; },
      result() { return (rows[table] || []).filter(r => filters.every(f => f(r))).slice(0, limit); },
      async single() {
        if (insert) {
          if (table === 'certificate_survey_entitlement' && rows[table].some(r =>
            r.booking_id === insert.booking_id && r.assignment_id === insert.assignment_id)) return { error: { code: '23505' } };
          const row = { id: crypto.randomUUID(), ...(table === 'campaign_survey_delivery' ? { status: 'pending' } : {}), ...insert };
          (rows[table] ||= []).push(row); return { data: row };
        }
        return q.maybeSingle();
      },
      async maybeSingle() { const row = q.result()[0]; if (row && update) Object.assign(row, update); return { data: row || null }; },
      then(resolve) { const result = q.result(); if (update) result.forEach(r => Object.assign(r, update)); return Promise.resolve({ data: result }).then(resolve); },
    };
    return q;
  } };
  const campaign = { subject: '{{attendee_first_name}} — {{event_survey_list}}',
    html_content: '<p>Hello {{attendee_first_name}} {{attendee_last_name}} ([[attendee.email]])</p>{{event_survey_list}}',
    event_survey_context: { event_type: 'event', event_id: 'event' } };
  return { db, rows, campaign, recipient: { email: 'isaasitesting2@outlook.com', first_name: 'Wrong member name' } };
}

test('reported literal tokens render populated HTML from the scoped source attendee and existing survey assignment', async () => {
  const f = fixture();
  const result = await resolveCampaignAttendeeContent(f.db, f.campaign, 'tenant', f.recipient);
  assert.match(result.html, /Hello Isa &amp; Ann Tester \(isaasitesting2@outlook.com\)/);
  assert.match(result.html, /href="https:\/\/fixture.invalid\/survey\/existing-assignment-token"/);
  assert.match(result.html, /Event feedback/);
  assert.doesNotMatch(result.html, /\{\{|Wrong member|certificate_grant|booking_id/);
  assert.equal(result.subject, 'Isa & Ann — Event surveys');
});

test('source required, explicit event required, and tenant/event/email mismatches fail closed', async () => {
  const f = fixture();
  await assert.rejects(resolveCampaignAttendeeContent(f.db, f.campaign, 'tenant', null), /source attendee/);
  await assert.rejects(resolveCampaignAttendeeContent(f.db, { ...f.campaign, event_survey_context: null }, 'tenant', f.recipient), /select an event/);
  await assert.rejects(resolveCampaignAttendeeContent(f.db, f.campaign, 'foreign', f.recipient), /unavailable/);
  await assert.rejects(resolveCampaignAttendeeContent(f.db, f.campaign, 'tenant', { email: 'reviewer@example.com' }), /No confirmed attendee/);
  f.rows.booking[0].event_id = 'other-event';
  await assert.rejects(resolveCampaignAttendeeContent(f.db, f.campaign, 'tenant', f.recipient), /No confirmed attendee/);
});

test('complex-event attendees use their own booking table; foreign/event-mismatched surveys are excluded', async () => {
  const f = fixture();
  f.rows.complex_event = f.rows.event;
  f.rows.complex_event_booking = f.rows.booking;
  f.rows.booking = [];
  f.campaign.event_survey_context.event_type = 'complex_event';
  Object.assign(f.rows.event_survey_assignment[0], { event_type: 'complex_event', complex_event_id: 'event' });
  f.rows.event_survey_assignment.push(
    { ...f.rows.event_survey_assignment[0], id: 'foreign', tenant_id: 'foreign', token: 'FOREIGN-SECRET' },
    { ...f.rows.event_survey_assignment[0], id: 'other', complex_event_id: 'other', token: 'OTHER-EVENT-SECRET' },
  );
  const result = await resolveCampaignAttendeeContent(f.db, f.campaign, 'tenant', f.recipient);
  assert.match(result.html, /Hello Isa &amp; Ann/);
  assert.match(result.html, /existing-assignment-token/);
  assert.doesNotMatch(result.html, /FOREIGN-SECRET|OTHER-EVENT-SECRET/);
  f.rows.complex_event_booking[0].tenant_id = 'foreign';
  await assert.rejects(resolveCampaignAttendeeContent(f.db, f.campaign, 'tenant', f.recipient), /No confirmed attendee/);
});

test('empty/closed surveys have explicit empty state; unpublished assignments fail rather than leak links', async () => {
  const f = fixture();
  f.rows.event_survey_assignment[0].closes_at = '2000-01-01';
  assert.match((await resolveCampaignAttendeeContent(f.db, f.campaign, 'tenant', f.recipient)).html, /No surveys are currently available/);
  f.rows.event_survey_assignment[0].closes_at = null;
  f.rows.form[0].survey_settings.status = 'draft';
  await assert.rejects(resolveCampaignAttendeeContent(f.db, f.campaign, 'tenant', f.recipient), /active and published/);
});

test('ordinary no-source content is unchanged and recipient data cannot inject tokens or HTML', async () => {
  const f = fixture();
  assert.deepEqual(await resolveCampaignAttendeeContent(f.db, { subject: 'Hello', html_content: '<p>Hi</p>' }, 'tenant', null),
    { subject: 'Hello', html: '<p>Hi</p>' });
  f.rows.booking[0].attendee_first_name = '<script>{{event_survey_list}}</script>';
  const result = await resolveCampaignAttendeeContent(f.db, f.campaign, 'tenant', f.recipient);
  assert.match(result.html, /&lt;script&gt;&#123;&#123;event_survey_list/);
  assert.equal((result.html.match(/<ul>/g) || []).length, 1);
});

test('real and selected-source sends use the same resolver before tracking; no-source test validates before transport', async () => {
  const service = await readFile(new URL('./campaignService.js', import.meta.url), 'utf8');
  const route = await readFile(new URL('../email-campaigns/test-send.js', import.meta.url), 'utf8');
  assert.match(service, /resolveCampaignAttendeeContent\(supabase, \{ \.\.\.campaign, html_content: html, subject \}, tenantId, recipient\)/);
  assert.match(route, /sendToRecipient\(sourceRecipient, campaign, tenantId, tenantSlug, requestHost, composition, valid\[i\]\)/);
  assert.match(route, /await resolveCampaignAttendeeContent\(supabase, campaign, tenantId, null\)/);
});

test('actual real and source-test send paths deliver identical populated attendee/survey content', async () => {
  const f = fixture();
  const sent = [];
  const source = (await readFile(new URL('./campaignService.js', import.meta.url), 'utf8'))
    .replace(/import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];?/g, '')
    .replace(/export (async )?function /g, '$1function ');
  const { sendToRecipient } = vm.runInNewContext(`${source}\n;({sendToRecipient})`, {
    process: { env: {} }, crypto, Buffer, supabase: f.db, console,
    resolveCampaignAttendeeContent, resolveCampaignEventSurvey, replaceEventSurvey,
    prepareCampaignSurveyDelivery, finishCampaignSurveyDelivery,
    resolveCampaignEventSponsors, replaceEventSponsors, isStandaloneCampaignPreferencePlaceholder,
    replacePlaceholders: text => text,
    sendEmail: async payload => { sent.push(payload); return { success: true }; },
  });
  const campaign = { ...f.campaign, id: 'campaign', track_clicks: false, track_opens: false };
  assert.equal(await sendToRecipient({ ...f.recipient, id: 'recipient' }, campaign,
    'tenant', 'fixture', null, { hasUnsubscribeBlock: true }), 'sent');
  const preview = await sendToRecipient({ ...f.recipient, id: 'recipient' }, campaign,
    'tenant', 'fixture', null, { hasUnsubscribeBlock: true }, 'reviewer@example.com');
  assert.equal(preview.success, true);
  for (const payload of sent) {
    assert.match(payload.html, /Hello Isa &amp; Ann Tester/);
    assert.match(payload.html, /Event feedback/);
    assert.doesNotMatch(payload.html, /\{\{attendee_first_name\}\}|\{\{event_survey_list\}\}/);
  }
  assert.equal(sent[0].to, f.recipient.email);
  assert.equal(sent[1].to, 'reviewer@example.com');
  assert.match(sent[1].html, /https:\/\/fixture.invalid\/survey\/existing-assignment-token/);
  assert.match(sent[1].html, /certificate_grant=/);
  assert.equal(f.rows.campaign_survey_delivery[0].purpose, 'live');
  assert.equal(f.rows.campaign_survey_delivery[1].purpose, 'test');
  assert.equal(f.rows.campaign_survey_delivery[1].destination_email, 'reviewer@example.com');
  assert.equal(f.rows.campaign_survey_delivery[1].source_email, f.recipient.email);
  assert.equal(f.rows.certificate_survey_entitlement.length, 1);
  assert.ok(sent.every(p => p.disableTracking));
  assert.ok(f.rows.certificate_survey_credential.every(c => !c.delivery_id && c.campaign_delivery_id));
  for (const payload of sent) {
    const token = payload.html.match(/certificate_grant=([A-Za-z0-9_-]{43})/)[1];
    assert.equal((await getInvitation(f, token)).status, 200);
    assert.doesNotMatch(payload.html, /url=[^"]*certificate_grant/);
  }
});

test('invitation URL aliases cannot leak through third-party URL concatenation or remote assets', () => {
  const url = 'https://fixture.invalid/survey/assignment#certificate_grant=secret';
  for (const html of [
    '<a href="https://evil.invalid/?leak={{event_survey_url}}">click</a>',
    '<img src="{{event_survey_url}}">',
    '<style>x{background:url({{event_survey_url}})}</style>',
    '<script> {{event_survey_url}} </script>',
    '<svg> {{event_survey_url}} </svg>',
    '<a href="{{event_survey_url}}suffix">click</a>',
  ]) assert.doesNotMatch(replaceCampaignSurveyInvitation(html, url), /certificate_grant/);
  assert.match(replaceCampaignSurveyInvitation('<a href="{{event_survey_url}}">Survey</a>', url), /certificate_grant/);
});

test('actual send failures, uncertain acceptance and retries preserve the delivery boundary', async () => {
  const source = (await readFile(new URL('./campaignService.js', import.meta.url), 'utf8'))
    .replace(/import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];?/g, '')
    .replace(/export (async )?function /g, '$1function ');
  for (const ambiguousEffect of [false, true]) {
    const f = fixture();
    let sends = 0;
    const { sendToRecipient } = vm.runInNewContext(`${source}\n;({sendToRecipient})`, {
      process: { env: {} }, crypto, Buffer, supabase: f.db,
      console: { log() {}, error() {}, warn() {} },
      resolveCampaignAttendeeContent, resolveCampaignEventSurvey, replaceEventSurvey,
      prepareCampaignSurveyDelivery, finishCampaignSurveyDelivery,
      resolveCampaignEventSponsors, replaceEventSponsors, isStandaloneCampaignPreferencePlaceholder,
      replacePlaceholders: text => text,
      sendEmail: async () => { sends++; return sends === 1
        ? { success: false, ambiguousEffect } : { success: true }; },
    });
    const send = () => sendToRecipient({ ...f.recipient, id: 'recipient' },
      { ...f.campaign, id: 'campaign' }, 'tenant', 'fixture', null, {});
    assert.equal(await send(), 'failed');
    assert.equal(f.rows.campaign_survey_delivery[0].status, ambiguousEffect ? 'pending' : 'failed');
    assert.equal(await send(), ambiguousEffect ? 'failed' : 'sent');
    assert.equal(sends, ambiguousEffect ? 1 : 2);
    assert.equal(f.rows.certificate_survey_entitlement.length, 1);
    if (!ambiguousEffect) {
      assert.equal(await send(), 'sent');
      assert.equal(sends, 2);
    }
  }
});

async function getInvitation(f, token, member = null) {
  const output = {};
  const res = { setHeader() {}, status(code) { output.status = code; return res; }, json(body) { output.body = body; return res; } };
  await surveyAssignmentHandler({ method: 'GET', query: { token: 'existing-assignment-token' },
    headers: token ? { 'x-certificate-survey-grant': token } : {} }, res, {
    supabase: f.db, resolveTenant: async () => f.rows.tenant[0],
    getSessionMember: async () => member, getSession: async () => null,
  });
  return output;
}

test('actual campaign links authorize logged-out GET only after acceptance and enforce all source scope', async () => {
  for (const testSend of [false, true]) {
    const f = fixture();
    const params = { db: f.db, campaign: { ...f.campaign, id: 'campaign' },
      tenantId: 'tenant', recipient: { ...f.recipient, id: 'recipient' },
      destination: testSend ? 'reviewer@example.com' : f.recipient.email, test: testSend };
    const prepared = await prepareCampaignSurveyDelivery(params);
    const token = prepared.html.match(/certificate_grant=([A-Za-z0-9_-]{43})/)[1];
    assert.equal((await getInvitation(f, token)).status, 403);
    await finishCampaignSurveyDelivery(f.db, prepared.deliveryId, true);
    assert.equal((await getInvitation(f, token)).status, 200);
    assert.equal((await getInvitation(f)).body.require_authentication, true);
    for (const [row, key, bad] of [
      [f.rows.campaign_survey_delivery[0], 'status', 'failed'],
      [f.rows.campaign_survey_delivery[0], 'tenant_id', 'foreign'],
      [f.rows.booking[0], 'event_id', 'foreign'],
      [f.rows.booking[0], 'status', 'cancelled'],
      [f.rows.booking[0], 'attendee_email', 'someone@example.com'],
      [f.rows.certificate_survey_entitlement[0], 'revoked_at', new Date().toISOString()],
      [f.rows.certificate_survey_entitlement[0], 'assignment_id', 'other'],
      [f.rows.certificate_survey_credential[0], 'expires_at', '2000-01-01'],
      [f.rows.certificate_survey_credential[0], 'revoked_at', new Date().toISOString()],
    ]) {
      const old = row[key]; row[key] = bad;
      assert.equal((await getInvitation(f, token)).status, 403, key);
      row[key] = old;
    }
    assert.equal((await getInvitation(f, token)).status, 200);
    if (!testSend) assert.equal((await prepareCampaignSurveyDelivery(params)).alreadyAccepted, true);
    assert.equal(f.rows.certificate_survey_credential.length, 1);
  }
});

test('single URL aliases receive the same fragment grant; failed retries share entitlement, pending blocks replay', async () => {
  const f = fixture();
  const params = { db: f.db, campaign: { ...f.campaign, id: 'campaign',
    subject: '{{event_survey_url}}', html_content: '<a href="{{event_survey_url}}">Survey</a> [[event.survey_url]]' },
  tenantId: 'tenant', recipient: { ...f.recipient, id: 'recipient' }, destination: f.recipient.email };
  const first = await prepareCampaignSurveyDelivery(params);
  assert.match(first.html, /certificate_grant=/);
  assert.doesNotMatch(first.subject, /certificate_grant/);
  await assert.rejects(prepareCampaignSurveyDelivery(params), /unresolved/);
  await finishCampaignSurveyDelivery(f.db, first.deliveryId, false);
  const second = await prepareCampaignSurveyDelivery(params);
  assert.notEqual(first.deliveryId, second.deliveryId);
  assert.equal(f.rows.certificate_survey_entitlement.length, 1);
  assert.equal(f.rows.certificate_survey_credential.length, 2);
  assert.equal((await getInvitation(f, first.html.match(/certificate_grant=([A-Za-z0-9_-]{43})/)[1])).status, 403);
});

test('generated campaign invitation reaches logged-out submission RPC with source identity, never test destination', async () => {
  const f = fixture();
  Object.assign(f.rows.form[0], { require_authentication: true, entity_action: 'none',
    entity_pipelines: { members: [], organisations: [] } });
  const settings = { ...f.rows.form[0].survey_settings, response_identity: 'identified' };
  f.rows.form[0].survey_settings = settings;
  Object.assign(f.rows.survey_version[0], { fields: [{ id: 'feedback', type: 'text' }, { id: 'email', type: 'email' }],
    pages: [], visibility_rules: [], survey_settings: settings });
  const prepared = await prepareCampaignSurveyDelivery({ db: f.db,
    campaign: { ...f.campaign, id: 'campaign' }, tenantId: 'tenant',
    recipient: f.recipient, destination: 'reviewer@example.com', test: true });
  const token = prepared.html.match(/certificate_grant=([A-Za-z0-9_-]{43})/)[1];
  const calls = [];
  f.db.rpc = async (name, args) => {
    calls.push({ name, args });
    return { data: [{ id: 'response', ...args.p_submission }], error: null };
  };
  const submit = async (supplied = token, sessionEmail = null) => {
    const out = {};
    const res = { setHeader() {}, status(code) { out.status = code; return res; }, json(body) { out.body = body; return res; } };
    await submissionHandler({ method: 'POST', headers: { host: 'fixture.invalid' },
      body: { form_id: 'form', assignment_token: 'existing-assignment-token',
        certificate_survey_grant: supplied, submission_data: { feedback: 'Good', email: 'forged@example.com' } } }, res, {
      supabase: f.db, tenantData: f.rows.tenant[0],
      getSessionMember: async () => sessionEmail ? { email: sessionEmail, tenant_id: 'tenant' } : null,
      getSession: async () => null,
      sendSubmissionEmailsGuarded: async () => { throw new Error('Unexpected mail'); },
    });
    return out;
  };
  assert.equal((await submit()).status, 403);
  await finishCampaignSurveyDelivery(f.db, prepared.deliveryId, true);
  assert.equal((await submit(null)).status, 403);
  assert.equal((await submit(token, 'wrong@example.com')).status, 403);
  for (const [row, key, bad] of [
    [f.rows.campaign_survey_delivery[0], 'tenant_id', 'other'],
    [f.rows.certificate_survey_credential[0], 'expires_at', '2000-01-01'],
    [f.rows.certificate_survey_entitlement[0], 'revoked_at', new Date().toISOString()],
    [f.rows.booking[0], 'event_id', 'other'],
    [f.rows.booking[0], 'status', 'cancelled'],
  ]) {
    const old = row[key]; row[key] = bad;
    assert.equal((await submit()).status, 403, key);
    row[key] = old;
  }
  const accepted = await submit();
  assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'create_certificate_survey_submission');
  assert.equal(calls[0].args.p_submission.submitted_by_email, f.recipient.email);
  assert.doesNotMatch(JSON.stringify(calls), /reviewer@example|forged@example/);
});

test('complex-event campaign invitation is bound to the complex attendee, never a standard booking', async () => {
  const f = fixture();
  f.rows.complex_event = f.rows.event;
  f.rows.complex_event_booking = f.rows.booking;
  f.rows.booking = [];
  f.campaign.event_survey_context.event_type = 'complex_event';
  Object.assign(f.rows.event_survey_assignment[0], { event_type: 'complex_event', complex_event_id: 'event', event_id: null });
  const prepared = await prepareCampaignSurveyDelivery({ db: f.db,
    campaign: { ...f.campaign, id: 'campaign' }, tenantId: 'tenant',
    recipient: f.recipient, destination: 'reviewer@example.com', test: true });
  await finishCampaignSurveyDelivery(f.db, prepared.deliveryId, true);
  const token = prepared.html.match(/certificate_grant=([A-Za-z0-9_-]{43})/)[1];
  assert.equal(f.rows.certificate_survey_entitlement[0].booking_source, 'complex');
  assert.equal((await getInvitation(f, token)).status, 200);
  f.rows.complex_event_booking[0].tenant_id = 'other';
  assert.equal((await getInvitation(f, token)).status, 403);
});