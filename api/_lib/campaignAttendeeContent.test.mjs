import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { resolveCampaignAttendeeContent } from './campaignAttendeeContent.js';
import { resolveCampaignEventSurvey, replaceEventSurvey } from './campaignEventSurvey.js';
import { resolveCampaignEventSponsors, replaceEventSponsors } from './eventEmailSponsors.js';
import { isStandaloneCampaignPreferencePlaceholder } from './campaignEmailComposition.js';

function fixture() {
  const rows = {
    event: [{ id: 'event', tenant_id: 'tenant' }],
    tenant: [{ id: 'tenant', slug: 'fixture', domain: 'fixture.invalid' }],
    booking: [{ id: 'booking', tenant_id: 'tenant', event_id: 'event', status: 'confirmed',
      attendee_first_name: 'Isa & Ann', attendee_last_name: 'Tester', attendee_email: 'isaasitesting2@outlook.com' }],
    event_survey_assignment: [{ id: 'assignment', tenant_id: 'tenant', event_id: 'event', event_type: 'event',
      status: 'active', token: 'existing-assignment-token', form_id: 'form' }],
    form: [{ id: 'form', tenant_id: 'tenant', name: 'Event feedback', is_active: true, form_type: 'survey',
      survey_settings: { status: 'published', current_version: 1 } }],
    survey_version: [{ id: 'version', tenant_id: 'tenant', form_id: 'form', version_number: 1 }],
  };
  const db = { from(table) {
    const filters = [];
    let limit = Infinity;
    const q = {
      select() { return q; }, update() { return q; }, eq(k, v) { filters.push(r => r[k] === v); return q; },
      ilike(k, v) { filters.push(r => r[k]?.toLowerCase() === v.toLowerCase()); return q; },
      order() { return q; }, limit(n) { limit = n; return q; }, range() { return q; },
      result() { return (rows[table] || []).filter(r => filters.every(f => f(r))).slice(0, limit); },
      async maybeSingle() { return { data: q.result()[0] || null }; },
      then(resolve) { return Promise.resolve({ data: q.result() }).then(resolve); },
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
});