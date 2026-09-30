import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { resolveCampaignEventSponsors, replaceEventSponsors } from './eventEmailSponsors.js';
import { resolveCampaignEventSurvey, replaceEventSurvey, resolveEventEmailSurvey } from './campaignEventSurvey.js';
import { sanitizeSlotHtml } from './slotHtmlSanitizer.js';
import { resolveEventEmailPreview } from '../../client/src/lib/eventEmailPreview.js';

function fixture() {
  const rows = {
    tenant: [{ id: 't', slug: 'fixture', domain: 'sponsors.fixture.invalid' }],
    event: [{ id: 'e1', tenant_id: 't' }, { id: 'e2', tenant_id: 't' }],
    event_sponsor_assignment: [1, 2].map(n => ({ tenant_id: 't', event_id: `e${n}`, event_type: 'simple', sponsor_id: `s${n}` })),
    event_sponsor: [
      { id: 's1', tenant_id: 't', name: 'Alpha <script>alert(1)</script> & Co', logo_url: '/logo.png?a=1&b=2', website_url: 'https://sponsor.invalid/?a=1&b=2', internal_notes: 'PRIVATE' },
      { id: 's2', tenant_id: 't', name: 'Beta', logo_url: 'javascript:alert(1)', website_url: 'javascript:alert(1)' },
    ],
    event_sponsor_category: [],
  };
  const calls = [];
  const db = { from(table) {
    calls.push(table);
    const filters = [];
    const q = {
      select() { return q; }, update() { return q; },
      eq(k, v) { filters.push(r => r[k] === v); return q; },
      in(k, v) { filters.push(r => v.includes(r[k])); return q; },
      order(k) { q.sortKey = k; return q; },
      result() { const list = (rows[table] || []).filter(r => filters.every(f => f(r))); return q.sortKey ? list.sort((a,b) => a[q.sortKey] - b[q.sortKey]) : list; },
      async maybeSingle() { return { data: q.result()[0] || null }; },
      then(resolve) { return Promise.resolve({ data: q.result() }).then(resolve); },
    };
    return q;
  }};
  const campaign = { id: 'c', subject: 'Our event', html_content: '<p>{{event_sponsors}}</p>', event_survey_context: { event_id: 'e1', event_type: 'event' } };
  return { rows, db, campaign, calls };
}

test('two events share a template; public fields only, safe links, canonical relative logos, no survey dependency', async () => {
  const f = fixture();
  for (const n of [1, 2]) {
    f.campaign.event_survey_context.event_id = `e${n}`;
    const fragment = await resolveCampaignEventSponsors(f.db, f.campaign, 't');
    const html = replaceEventSponsors(sanitizeSlotHtml(f.campaign.html_content), fragment);
    const doc = new JSDOM(html).window.document;
    assert.equal(doc.querySelectorAll('table').length, 1);
    assert.equal(doc.querySelectorAll('p table, script').length, 0);
    assert.doesNotMatch(html, /PRIVATE|javascript:/);
    assert.match(doc.body.textContent, n === 1 ? /Alpha/ : /Beta/);
    if (n === 1) {
      assert.equal(doc.querySelector('img').src, 'https://sponsors.fixture.invalid/logo.png?a=1&b=2');
      assert.equal(doc.querySelector('a').href, 'https://sponsor.invalid/?a=1&b=2');
      assert.equal(doc.querySelector('img').alt, f.rows.event_sponsor[0].name);
    } else assert.equal(doc.querySelector('img,a'), null);
    assert.equal(resolveEventEmailPreview(f.campaign.html_content, { sponsors: fragment }), html);
  }
  assert.ok(!f.calls.includes('event_survey_assignment'));
});

for (const [label, mutate, expected] of [
  ['missing context', f => f.campaign.event_survey_context = null, /select an event/],
  ['deleted event', f => f.rows.event = [], /unavailable/],
  ['inactive event', f => f.rows.event[0].is_active = false, /unavailable/],
  ['wrong tenant event', f => f.rows.event[0].tenant_id = 'other', /unavailable/],
  ['subject', f => f.campaign.subject = '[[event.sponsors]]', /subjects/],
  ['href', f => f.campaign.html_content = '<a href="{{event_sponsors}}">bad</a>', /attribute/],
  ['inline', f => f.campaign.html_content = '<p>Hello {{event_sponsors}}</p>', /own body paragraph/],
]) test(`rejects ${label}`, async () => {
  const f = fixture(); mutate(f);
  await assert.rejects(resolveCampaignEventSponsors(f.db, f.campaign, 't'), expected);
});

for (const label of ['empty', 'hidden', 'wrong tenant sponsor', 'wrong event assignment']) test(`${label} produces no empty heading`, async () => {
  const f = fixture();
  if (label === 'empty') f.rows.event_sponsor_assignment = [];
  if (label === 'hidden') f.rows.event[0].sponsor_display_mode = 'hidden';
  if (label === 'wrong tenant sponsor') f.rows.event_sponsor[0].tenant_id = 'other';
  if (label === 'wrong event assignment') f.rows.event_sponsor_assignment[0].event_type = 'complex';
  assert.equal(await resolveCampaignEventSponsors(f.db, f.campaign, 't'), '');
});

test('existing public tiers use sponsor category, tier order then name, uncategorized last', async () => {
  const f = fixture();
  f.rows.event_sponsor_category = [{ id: 'gold', tenant_id: 't', name: 'Gold', display_order: 1 }, { id: 'silver', tenant_id: 't', name: 'Silver', display_order: 2 }];
  f.rows.event_sponsor[0].category_id = 'silver';
  f.rows.event_sponsor[1].category_id = 'gold';
  f.rows.event_sponsor_assignment[1].event_id = 'e1';
  const html = await resolveCampaignEventSponsors(f.db, f.campaign, 't');
  assert.ok(html.indexOf('Gold') < html.indexOf('Silver'));
});

for (const url of ['data:image/svg+xml,<svg onload=alert(1)>', '//evil.invalid/logo', 'java\nscript:alert(1)', 'https://user:pass@evil.invalid/', '\\\\evil.invalid\\logo', 'vbscript:alert(1)']) {
  test(`rejects unsafe sponsor URL ${JSON.stringify(url)}`, async () => {
    const f = fixture();
    Object.assign(f.rows.event_sponsor[0], { website_url: url, logo_url: url });
    const html = await resolveCampaignEventSponsors(f.db, f.campaign, 't');
    assert.equal(new JSDOM(html).window.document.querySelector('a,img'), null);
  });
}

test('untrusted sponsor names cannot inject further template instructions', async () => {
  const f = fixture();
  f.rows.event_sponsor[0].name = '[[member.email]] {{event_survey_url}}';
  const html = await resolveCampaignEventSponsors(f.db, f.campaign, 't');
  assert.doesNotMatch(html, /\[\[member|\{\{event/);
  assert.equal(new JSDOM(html).window.document.querySelector('img').alt, f.rows.event_sponsor[0].name);
});

test('transactional confirmation/reminder resolver derives sponsors from its canonical event', async () => {
  const f = fixture();
  for (const event of f.rows.event) {
    const rendered = await resolveEventEmailSurvey(f.db, { subject: 'Thanks', body: '<p>[[event.sponsors]]</p>' }, event, 'event');
    assert.match(rendered.body, event.id === 'e1' ? /Alpha/ : /Beta/);
    assert.doesNotMatch(rendered.body, /<p>\s*<table/);
  }
});

test('actual send adapter resolves current sponsors before tracking, rejects stale retries, and preserves query parameters', async () => {
  const f = fixture();
  const submissions = [];
  const source = (await readFile(new URL('./campaignService.js', import.meta.url), 'utf8'))
    .replace(/import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];?/g, '')
    .replace(/export (async )?function /g, '$1function ');
  const { sendToRecipient } = vm.runInNewContext(`${source}\n;({sendToRecipient})`, {
    process: { env: {} }, crypto, Buffer, supabase: f.db,
    resolveCampaignEventSurvey, replaceEventSurvey, resolveCampaignEventSponsors, replaceEventSponsors,
    replacePlaceholders: text => text,
    sendEmail: async payload => { submissions.push(payload); return { success: true }; },
    console: { error() {}, warn() {}, log() {} },
  });
  for (const n of [1, 2]) {
    f.campaign.event_survey_context.event_id = `e${n}`;
    const result = await sendToRecipient({ id: `r${n}`, email: 'recipient@fixture.invalid' }, f.campaign, 't', 'fixture', null, { hasUnsubscribeBlock: true });
    assert.equal(result, 'sent');
    const doc = new JSDOM(submissions.at(-1).html).window.document;
    assert.match(doc.body.textContent, n === 1 ? /Alpha/ : /Beta/);
    assert.equal(doc.querySelector('p table,script'), null);
    if (n === 1) assert.equal(new URL(doc.querySelector('a').href).searchParams.get('url'), 'https://sponsor.invalid/?a=1&b=2');
  }
  f.rows.event[1].is_active = false;
  assert.equal(await sendToRecipient({ id: 'retry', email: 'recipient@fixture.invalid' }, f.campaign, 't', 'fixture', null, {}), 'failed');
  assert.equal(submissions.length, 2);
});

test('actual preview endpoint allows tenant admin or authorized group admin only and resolves sponsors without surveys', async () => {
  const source = (await readFile(new URL('../email-campaigns/preview-survey.js', import.meta.url), 'utf8'))
    .replace(/import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];?/g, '')
    .replace('export default async function handler', 'async function handler');
  for (const mode of ['admin', 'group', 'wrong-group', 'wrong-tenant', 'anonymous']) {
    const f = fixture();
    const { handler } = vm.runInNewContext(`${source};({handler})`, {
      supabase: f.db, resolveCampaignEventSurvey, resolveCampaignEventSponsors,
      getTenantContext: async () => ({ isAuthenticated: mode !== 'anonymous', tenantId: 't' }),
      hasAdminAccess: async () => mode === 'admin',
      getCallerEmsAccess: async () => ({ error: mode === 'anonymous', tenantContext: { tenantId: mode === 'wrong-tenant' ? 'other' : 't' }, groups: mode === 'wrong-group' ? [] : ['g'] }),
      requireGroupAccess: (groups, id) => groups.includes(id),
    });
    const res = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; }, setHeader() {} };
    await handler({ method: 'POST', body: { ...f.campaign, groupId: 'g' } }, res);
    if (['admin', 'group'].includes(mode)) {
      assert.equal(res.code, 200);
      assert.match(res.body.sponsors, /Alpha/);
      assert.equal(res.body.url, null);
    } else {
      assert.equal(res.code, 403);
      assert.equal(f.calls.length, 0);
    }
  }
});