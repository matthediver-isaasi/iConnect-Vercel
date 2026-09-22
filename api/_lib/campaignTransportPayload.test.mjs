import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Mailgun from 'mailgun.js';

process.env.MAILGUN_API_KEY = 'mock-campaign-transport-key';
process.env.APP_DOMAIN = 'example.test';

const transportCalls = [];
const originalMailgunClient = Mailgun.prototype.client;
Mailgun.prototype.client = () => ({
  messages: {
    create: async (domain, payload) => {
      transportCalls.push({ domain, payload });
      return { id: `<mock-${transportCalls.length}>` };
    },
  },
});

const [{ sendEmail }, { supabase }] = await Promise.all([
  import('./emailService.js'),
  import('./database.js'),
]);

const originalFrom = supabase.from;
supabase.from = (table) => {
  const filters = new Map();
  const query = {
    select() { return query; },
    eq(column, value) {
      filters.set(column, value);
      return query;
    },
    async single() {
      if (table === 'tenant') {
        const tenantId = filters.get('id');
        return {
          data: {
            id: tenantId,
            name: 'Fixture Tenant',
            slug: 'fixture',
            settings: {
              email_domain: {
                status: 'verified',
                domain: 'mail.fixture.test',
                from_email: 'news@mail.fixture.test',
                from_name: 'Fixture Tenant',
              },
            },
          },
          error: null,
        };
      }
      if (table === 'system_settings') {
        if (filters.get('setting_key') === 'email_footer_html') {
          return {
            data: {
              setting_value: '<footer data-fixture="tenant-footer">Tenant footer {{unsubscribe_link}}</footer>',
            },
            error: null,
          };
        }
        if (filters.get('setting_key') === 'social_icons_config') {
          return { data: null, error: null };
        }
      }
      throw new Error(`Unexpected campaign fixture query: ${table}`);
    },
  };
  return query;
};

after(() => {
  supabase.from = originalFrom;
  Mailgun.prototype.client = originalMailgunClient;
});

async function finalPayload(options) {
  const before = transportCalls.length;
  const result = await sendEmail(options);
  assert.equal(result.success, true);
  assert.equal(transportCalls.length, before + 1);
  return transportCalls.at(-1);
}

test('production campaign final payload retains tracking, unsubscribe headers, and footer fallback', async () => {
  const preferencesUrl = 'https://fixture.example.test/email-preferences?t=campaign-token';
  const oneClickUrl = 'https://fixture.example.test/api/email-campaigns/unsubscribe?t=campaign-token&confirm=true';
  const fallback = `<p data-fixture="campaign-fallback"><a href="${preferencesUrl}">Manage email preferences</a></p>`;

  const { domain, payload } = await finalPayload({
    to: 'recipient@example.test',
    subject: 'Campaign fixture',
    html: `<main><a href="${preferencesUrl}">Unsubscribe</a></main>${fallback}`,
    from: 'Campaign Sender <sender@fixture.test>',
    tenantId: 'campaign-production-fixture',
    skipFooter: false,
    contentWidth: '640px',
    enableTracking: true,
    unsubscribeUrl: oneClickUrl,
    resolveTransactionalPreferences: false,
  });

  assert.equal(domain, 'mail.fixture.test');
  assert.deepEqual(payload.to, ['recipient@example.test']);
  assert.equal(payload['o:tracking'], 'yes');
  assert.equal(payload['o:tracking-opens'], 'yes');
  assert.equal(payload['o:tracking-clicks'], 'htmlonly');
  assert.equal(
    payload['h:List-Unsubscribe'],
    `<mailto:unsubscribe@mail.fixture.test>, <${oneClickUrl}>`,
  );
  assert.equal(payload['h:List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assert.match(payload.html, /data-fixture="campaign-fallback"/);
  assert.match(payload.html, /width="640"/);
  assert.match(payload.html, /data-fixture="tenant-footer"/);
  assert.match(payload.html, /\{\{unsubscribe_link\}\}/);
});

test('email-campaign test-send final payload retains its footer fallback without production headers', async () => {
  const preferencesUrl = 'https://fixture.example.test/email-preferences?t=email-test-token';
  const { payload } = await finalPayload({
    to: 'admin@example.test',
    subject: '[TEST] Campaign fixture',
    html: `<main>Test body</main><p data-fixture="test-fallback"><a href="${preferencesUrl}">Manage email preferences</a></p>`,
    from: 'Campaign Sender <sender@fixture.test>',
    tenantId: 'email-campaign-test-fixture',
    skipFooter: false,
    contentWidth: '600px',
    resolveTransactionalPreferences: false,
  });

  assert.match(payload.html, /data-fixture="test-fallback"/);
  assert.match(payload.html, /data-fixture="tenant-footer"/);
  assert.match(payload.html, /\{\{unsubscribe_link\}\}/);
  assert.equal(payload['o:tracking'], undefined);
  assert.equal(payload['h:List-Unsubscribe'], undefined);
  assert.equal(payload['h:List-Unsubscribe-Post'], undefined);
});

test('member-campaign visual Unsub test-send retains rendered markup and skips tenant footer', async () => {
  const preferencesUrl = 'https://fixture.example.test/email-preferences?t=member-test-token';
  const visualUnsub = `<a href="${preferencesUrl}" style="color: #999999; text-decoration: underline;">Unsubscribe from these emails</a>`;
  const { payload } = await finalPayload({
    to: 'group-admin@example.test',
    subject: '[TEST] Member campaign fixture',
    html: `<main>Member campaign</main><div data-fixture="visual-unsub">${visualUnsub}</div>`,
    from: 'Group Sender <sender@fixture.test>',
    tenantId: 'member-campaign-test-fixture',
    skipFooter: true,
    contentWidth: '720px',
    resolveTransactionalPreferences: false,
  });

  assert.match(payload.html, /data-fixture="visual-unsub"/);
  assert.match(payload.html, /t=member-test-token/);
  assert.doesNotMatch(payload.html, /data-fixture="tenant-footer"/);
  assert.equal(payload['o:tracking'], undefined);
  assert.equal(payload['h:List-Unsubscribe'], undefined);
});

test('all campaign send call sites explicitly opt out of transactional preference resolution', async () => {
  const fixtures = [
    ['campaign production', new URL('./campaignService.js', import.meta.url)],
    ['email campaign test-send', new URL('../email-campaigns/test-send.js', import.meta.url)],
    ['member campaign test-send', new URL('../member-campaigns/test-send.js', import.meta.url)],
  ];

  for (const [name, url] of fixtures) {
    const source = await readFile(url, 'utf8');
    const sendCalls = [...source.matchAll(/await sendEmail\(\{([\s\S]*?)\n\s*\}\);/g)];
    assert.ok(sendCalls.length > 0, `${name} has a sendEmail call`);
    assert.ok(
      sendCalls.some(([, options]) => /resolveTransactionalPreferences:\s*false/.test(options)),
      `${name} explicitly opts out`,
    );
  }
});