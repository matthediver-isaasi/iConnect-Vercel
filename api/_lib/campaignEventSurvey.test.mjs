import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveCampaignEventSurvey, replaceEventSurvey, resolveEventEmailSurvey } from './campaignEventSurvey.js';
import { sanitizeSlotHtml } from './slotHtmlSanitizer.js';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { resolveCampaignEventSponsors, replaceEventSponsors } from './eventEmailSponsors.js';
import { isStandaloneCampaignPreferencePlaceholder } from './campaignEmailComposition.js';

function fixture() {
  const rows = {
    tenant: [{ id: 't', slug: 'fixture', domain: 'survey.fixture.invalid' }],
    event: [{ id: 'e1', tenant_id: 't' }, { id: 'e2', tenant_id: 't' }],
    event_survey_assignment: ['1', '2'].map(n => ({
      id: `a${n}`, tenant_id: 't', event_id: `e${n}`, event_type: 'event',
      form_id: 'f', token: `private-token-${n}`, status: 'active', access_mode: 'authenticated',
    })),
    form: [{ id: 'f', tenant_id: 't', is_active: true, form_type: 'survey',
      access_policy: { mode: 'private' }, survey_settings: { status: 'published', current_version: 1 } }],
    survey_version: [{ id: 'v', tenant_id: 't', form_id: 'f', version_number: 1 }],
  };
  const db = { from(table) {
    const filters = [];
    const query = {
      select() { return query; },
      update() { return query; },
      eq(key, value) { filters.push([key, value]); return query; },
      result() { return (rows[table] || []).filter(row => filters.every(([key, value]) => row[key] === value)); },
      async maybeSingle() { return { data: query.result()[0] || null }; },
      then(resolve) { return Promise.resolve({ data: query.result() }).then(resolve); },
    };
    return query;
  } };
  const campaign = {
    subject: '{{event_survey_url}}',
    html_content: '<a href="[[event.survey_url]]">Survey {{event_survey_url}}</a>',
    event_survey_context: { event_type: 'event', event_id: 'e1' },
  };
  return { db, rows, campaign };
}

test('one reusable template resolves two events without changing access policy or minting tokens', async () => {
  const { db, rows, campaign } = fixture();
  const before = JSON.stringify(rows);
  for (const n of [1, 2]) {
    const url = await resolveCampaignEventSurvey(db, { ...campaign,
      event_survey_context: { event_type: 'event', event_id: `e${n}` } }, 't');
    assert.equal(url, `https://survey.fixture.invalid/survey/private-token-${n}`);
    assert.equal(replaceEventSurvey(campaign.subject, url), url);
    assert.equal(replaceEventSurvey(campaign.html_content, url), `<a href="${url}">Survey ${url}</a>`);
  }
  assert.equal(JSON.stringify(rows), before);
});

for (const [name, mutate, expected] of [
  ['missing event', f => { f.campaign.event_survey_context = null; }, /select an event/],
  ['deleted event', f => { f.rows.event = []; }, /event is unavailable/],
  ['no assignment', f => { f.rows.event_survey_assignment = []; }, /no matching/],
  ['other tenant assignment', f => { f.rows.event_survey_assignment[0].tenant_id = 'other'; }, /no matching/],
  ['other tenant form', f => { f.rows.form[0].tenant_id = 'other'; }, /active and published/],
  ['inactive form', f => { f.rows.form[0].is_active = false; }, /active and published/],
  ['unpublished form', f => { f.rows.form[0].survey_settings.status = 'draft'; }, /active and published/],
  ['deleted form', f => { f.rows.form = []; }, /active and published/],
  ['missing version', f => { f.rows.survey_version = []; }, /published version/],
  ['expired form', f => { f.rows.form[0].deactivate_at = '2000-01-01'; }, /active and published/],
  ['closed assignment', f => { f.rows.event_survey_assignment[0].closes_at = '2000-01-01'; }, /not open/],
  ['archived selected assignment', f => {
    f.campaign.event_survey_context.assignment_id = 'a1';
    f.rows.event_survey_assignment[0].status = 'archived';
  }, /not open/],
]) {
  test(`fails closed: ${name}; errors contain no private tokens`, async () => {
    const f = fixture();
    mutate(f);
    await assert.rejects(resolveCampaignEventSurvey(f.db, f.campaign, 't'), error => {
      assert.match(error.message, expected);
      assert.doesNotMatch(error.message, /private-token|https:/);
      return true;
    });
  });
}

test('multiple surveys require explicit matching selection', async () => {
  const f = fixture();
  f.rows.event_survey_assignment.push({ ...f.rows.event_survey_assignment[0], id: 'a3', token: 'selected' });
  await assert.rejects(resolveCampaignEventSurvey(f.db, f.campaign, 't'), /multiple surveys/);
  f.campaign.event_survey_context.assignment_id = 'a3';
  assert.match(await resolveCampaignEventSurvey(f.db, f.campaign, 't'), /\/survey\/selected$/);
  f.campaign.event_survey_context.assignment_id = 'a2';
  await assert.rejects(resolveCampaignEventSurvey(f.db, f.campaign, 't'), /no matching/);
});

test('automated event email configuration uses its own canonical event and explicit survey selection', async () => {
  const f = fixture();
  const config = { subject: '[[event.survey_url]]', body: '<a href="{{event_survey_url}}">Feedback</a>' };
  for (const event of f.rows.event) {
    const content = await resolveEventEmailSurvey(f.db, config, event, 'event');
    assert.match(content.subject, new RegExp(`private-token-${event.id.slice(1)}$`));
    assert.ok(content.body.includes(content.subject));
  }
  await assert.rejects(resolveEventEmailSurvey(f.db,
    { ...config, event_survey_assignment_id: 'a2' }, f.rows.event[0], 'event'), /no matching/);
});

test('unrelated campaigns perform no survey lookups; sanitizer preserves both token hrefs', async () => {
  assert.equal(await resolveCampaignEventSurvey({}, { subject: 'hello' }, 't'), null);
  for (const token of ['{{event_survey_url}}', '[[event.survey_url]]']) {
    assert.match(sanitizeSlotHtml(`<a href="${token}">Survey</a>`), /href=/);
    assert.ok(sanitizeSlotHtml(`<a href="${token}">Survey</a>`).includes(token));
  }
});

test('survey and sponsor tokens coexist without changing survey access rules', async () => {
  const f = fixture();
  f.rows.event_sponsor_assignment = [];
  const result = await resolveEventEmailSurvey(f.db, {
    subject: 'Feedback', body: '<p>[[event.sponsors]]</p><a href="{{event_survey_url}}">Feedback</a>',
  }, f.rows.event[0], 'event');
  assert.equal(result.body, '<a href="https://survey.fixture.invalid/survey/private-token-1">Feedback</a>');
});

test('actual per-recipient send resolves subject, body and tracked button; retries fail closed without token logs', async () => {
  const f = fixture();
  const submissions = [];
  const logs = [];
  const source = (await readFile(new URL('./campaignService.js', import.meta.url), 'utf8'))
    .replace(/import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];?/g, '')
    .replace(/export (async )?function /g, '$1function ');
  const { sendToRecipient } = vm.runInNewContext(`${source}\n;({sendToRecipient})`, {
    process: { env: {} }, crypto, Buffer,
    supabase: f.db, resolveCampaignEventSurvey, replaceEventSurvey, resolveCampaignEventSponsors, replaceEventSponsors,
    isStandaloneCampaignPreferencePlaceholder,
    replacePlaceholders: text => text,
    sendEmail: async payload => { submissions.push(payload); return { success: true }; },
    console: { error: (...args) => logs.push(args.join(' ')), warn: (...args) => logs.push(args.join(' ')), log() {} },
  });
  for (const n of [1, 2]) {
    const result = await sendToRecipient({ id: `r${n}`, email: 'recipient@fixture.invalid' },
      { ...f.campaign, id: 'c',
        subject: n === 1 ? '{{event_survey_url}}' : '[[event.survey_url]]',
        html_content: n === 1 ? f.campaign.html_content : '<a href="{{event_survey_url}}">Survey [[event.survey_url]]</a>',
        event_survey_context: { event_type: 'event', event_id: `e${n}` } },
      't', 'fixture', null, { hasUnsubscribeBlock: true });
    assert.equal(result, 'sent');
    const message = submissions.at(-1);
    const url = `https://survey.fixture.invalid/survey/private-token-${n}`;
    assert.equal(message.subject, url);
    assert.ok(message.html.includes(`Survey ${url}`));
    const href = message.html.match(/href="([^"]+)"/)[1];
    assert.equal(new URL(href.replaceAll('&amp;', '&')).searchParams.get('url'), url);
  }
  f.rows.event_survey_assignment[0].status = 'archived';
  assert.equal(await sendToRecipient({ id: 'retry', email: 'recipient@fixture.invalid' },
    f.campaign, 't', 'fixture', null, {}), 'failed');
  assert.equal(submissions.length, 2);
  assert.doesNotMatch(logs.join('\n'), /private-token|\/survey\//);
});