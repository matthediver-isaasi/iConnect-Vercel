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
const {
  getCampaignEmailComposition,
  hasEmbeddedTenantFooter,
} = await import('./campaignEmailComposition.js');

const TENANT_FOOTER = '<footer data-fixture="tenant-footer">Tenant footer {{unsubscribe_link}}</footer>';
const footerByTenant = new Map();

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
          const tenantId = filters.get('tenant_id');
          const settingValue = footerByTenant.has(tenantId)
            ? footerByTenant.get(tenantId)
            : TENANT_FOOTER;
          return {
            data: settingValue == null ? null : { setting_value: settingValue },
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
    campaignPreferences: {
      preferencesUrl,
      hasExplicitPreferenceBlock: false,
    },
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
  assert.doesNotMatch(payload.html, /\{\{unsubscribe_link\}\}/);
  assert.match(payload.html, /t=campaign-token/);
});

test('email-campaign test-send retains footer parity without actionable preference credentials', async () => {
  const { payload } = await finalPayload({
    to: 'admin@example.test',
    subject: '[TEST] Campaign fixture',
    html: '<main>Test body</main>',
    from: 'Campaign Sender <sender@fixture.test>',
    tenantId: 'email-campaign-test-fixture',
    skipFooter: false,
    contentWidth: '600px',
    campaignPreferences: {
      preferencesUrl: '#',
    },
    resolveTransactionalPreferences: false,
  });

  assert.match(payload.html, /data-fixture="tenant-footer"/);
  assert.doesNotMatch(payload.html, /\{\{unsubscribe_link\}\}/);
  assert.match(payload.html, /href="#"/);
  assert.doesNotMatch(`${payload.html}\n${payload.text}`, /email-preferences\?t=|test-/);
  assert.equal(payload['o:tracking'], undefined);
  assert.equal(payload['h:List-Unsubscribe'], undefined);
  assert.equal(payload['h:List-Unsubscribe-Post'], undefined);
});

test('member-campaign visual Unsub test-send retains rendered markup and skips tenant footer', async () => {
  const visualUnsub = '<a href="{{unsubscribe_url}}" style="color: #999999; text-decoration: underline;">Unsubscribe from these emails</a>';
  const { payload } = await finalPayload({
    to: 'group-admin@example.test',
    subject: '[TEST] Member campaign fixture',
    html: `<main>Member campaign</main><div data-fixture="visual-unsub">${visualUnsub}</div>`,
    from: 'Group Sender <sender@fixture.test>',
    tenantId: 'member-campaign-test-fixture',
    skipFooter: true,
    contentWidth: '720px',
    campaignPreferences: {
      preferencesUrl: '#',
    },
    resolveTransactionalPreferences: false,
  });

  assert.match(payload.html, /data-fixture="visual-unsub"/);
  assert.match(payload.html, /href="#"/);
  assert.doesNotMatch(`${payload.html}\n${payload.text}`, /email-preferences\?t=|member-test-/);
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
    assert.ok(
      sendCalls.some(([, options]) => /campaignPreferences:\s*\{/.test(options)),
      `${name} delegates final preference rendering to the transport`,
    );
  }
});


test('campaign composition recognizes supported footer structures without wording heuristics', () => {
  const nestedUnsubscribe = {
    blocks: [{
      type: 'section',
      columns: [{ blocks: [{ type: 'text' }, { type: 'unsubscribe' }] }],
    }],
  };
  for (const design_json of [nestedUnsubscribe, JSON.stringify(nestedUnsubscribe)]) {
    const composition = getCampaignEmailComposition({
      design_json,
      html_content: '<main>Body</main>',
    });
    assert.equal(composition.hasUnsubscribeBlock, true);
    assert.equal(composition.skipFooter, true);
  }

  const embedded = '<main>Body</main><section class="layout tenant-email-footer compact">Footer</section>';
  assert.equal(hasEmbeddedTenantFooter(embedded), true);
  assert.deepEqual(
    getCampaignEmailComposition({ design_json: { blocks: [] }, html_content: embedded }),
    {
      skipFooter: true,
      hasUnsubscribeBlock: false,
      hasEmbeddedTenantFooter: true,
      contentWidth: null,
      slotValues: null,
      hiddenSlots: null,
      richSlots: null,
    },
  );

  for (const fixture of [
    { design_json: { blocks: [{ type: 'text', content: 'unsubscribe from mail' }] }, html_content: '<footer>Unsubscribe</footer>' },
    { design_json: '{malformed', html_content: '<main>Body</main>' },
    { design_json: null, html_content: '<main>Plain HTML</main>' },
  ]) {
    const composition = getCampaignEmailComposition(fixture);
    assert.equal(composition.skipFooter, false);
    assert.equal(composition.hasUnsubscribeBlock, false);
    assert.equal(composition.hasEmbeddedTenantFooter, false);
  }
});

test('visual campaign without an embedded footer appends exactly one tenant footer and resolves its alias', async () => {
  const preferencesUrl = 'https://fixture.example.test/email-preferences?t=builder-token';
  const composition = getCampaignEmailComposition({
    design_json: JSON.stringify({ blocks: [{ type: 'text' }], globalStyles: { contentWidth: '620px' } }),
    html_content: '<main data-fixture="builder-body">Body</main>',
  });
  const { payload } = await finalPayload({
    to: 'recipient@example.test',
    subject: 'Builder campaign',
    html: '<main data-fixture="builder-body">Body</main>',
    tenantId: 'builder-no-footer-fixture',
    skipFooter: composition.skipFooter,
    contentWidth: composition.contentWidth,
    campaignPreferences: {
      preferencesUrl,
      hasExplicitPreferenceBlock: composition.hasUnsubscribeBlock,
    },
    resolveTransactionalPreferences: false,
  });

  assert.equal((payload.html.match(/data-fixture="tenant-footer"/g) || []).length, 1);
  assert.equal((payload.html.match(/t=builder-token/g) || []).length, 1);
  assert.doesNotMatch(payload.html, /\{\{(?:unsubscribe|communication_preferences)_(?:link|url)\}\}/i);
  assert.doesNotMatch(payload.html, /Manage email preferences/);
});

test('supported embedded footer is retained once and does not append the tenant footer', async () => {
  const preferencesUrl = 'https://fixture.example.test/email-preferences?t=embedded-token';
  const html = '<main>Body</main><section class="tenant-email-footer" data-fixture="embedded-footer">{{communication_preferences_link}}</section>';
  const composition = getCampaignEmailComposition({
    design_json: { blocks: [] },
    html_content: html,
  });
  const { payload } = await finalPayload({
    to: 'recipient@example.test',
    subject: 'Embedded footer campaign',
    html,
    tenantId: 'embedded-footer-fixture',
    skipFooter: composition.skipFooter,
    campaignPreferences: {
      preferencesUrl,
      hasExplicitPreferenceBlock: composition.hasUnsubscribeBlock,
    },
    resolveTransactionalPreferences: false,
  });

  assert.equal((payload.html.match(/data-fixture="embedded-footer"/g) || []).length, 1);
  assert.doesNotMatch(payload.html, /data-fixture="tenant-footer"/);
  assert.match(payload.html, /href="https:\/\/fixture\.example\.test\/email-preferences\?t=embedded-token"/);
  assert.doesNotMatch(payload.html, /Manage email preferences/);
});

test('nested unsubscribe block suppresses both tenant footer and generic fallback', async () => {
  const preferencesUrl = 'https://fixture.example.test/email-preferences?t=nested-token';
  const composition = getCampaignEmailComposition({
    design_json: {
      blocks: [{
        type: 'section',
        children: [{ type: 'unsubscribe' }],
      }],
    },
    html_content: '<main>Body</main><a data-fixture="visual-unsub" href="{{unsubscribe_url}}">Leave</a>',
  });
  const { payload } = await finalPayload({
    to: 'recipient@example.test',
    subject: 'Nested unsubscribe campaign',
    html: '<main>Body</main><a data-fixture="visual-unsub" href="{{unsubscribe_url}}">Leave</a>',
    tenantId: 'nested-unsubscribe-fixture',
    skipFooter: composition.skipFooter,
    campaignPreferences: {
      preferencesUrl,
      hasExplicitPreferenceBlock: composition.hasUnsubscribeBlock,
    },
    resolveTransactionalPreferences: false,
  });

  assert.match(payload.html, /data-fixture="visual-unsub"/);
  assert.match(payload.html, /t=nested-token/);
  assert.doesNotMatch(payload.html, /data-fixture="tenant-footer"/);
  assert.doesNotMatch(payload.html, /Manage email preferences/);
});

test('campaign without tenant or embedded footer receives one recipient-specific fallback', async () => {
  const tenantId = 'no-footer-fixture';
  footerByTenant.set(tenantId, null);
  const preferencesUrl = 'https://fixture.example.test/email-preferences?t=fallback-token';
  const { payload } = await finalPayload({
    to: 'recipient@example.test',
    subject: 'No configured footer campaign',
    html: '<main>Body</main>',
    tenantId,
    skipFooter: false,
    campaignPreferences: {
      preferencesUrl,
      hasExplicitPreferenceBlock: false,
    },
    resolveTransactionalPreferences: false,
  });

  assert.equal((payload.html.match(/Manage email preferences/g) || []).length, 1);
  assert.equal((payload.html.match(/t=fallback-token/g) || []).length, 1);
  assert.doesNotMatch(payload.html, /data-fixture="tenant-footer"/);
});

test('campaign preference URL resolves in HTML and explicit text while one-click headers remain production-only', async () => {
  const preferencesUrl = 'https://fixture.example.test/email-preferences?t=html-text-token';
  const oneClickUrl = 'https://fixture.example.test/api/email-campaigns/unsubscribe?t=html-text-token&confirm=true';
  const { payload } = await finalPayload({
    to: 'recipient@example.test',
    subject: 'HTML and text campaign',
    html: '<main>{{communication_preferences_link}}</main>',
    text: 'Preferences: {{communication_preferences_url}}',
    tenantId: 'html-text-fixture',
    skipFooter: true,
    enableTracking: true,
    unsubscribeUrl: oneClickUrl,
    campaignPreferences: {
      preferencesUrl,
      hasExplicitPreferenceBlock: true,
    },
    resolveTransactionalPreferences: false,
  });

  assert.match(payload.html, /href="https:\/\/fixture\.example\.test\/email-preferences\?t=html-text-token"/);
  assert.equal(payload.text, `Preferences: ${preferencesUrl}`);
  assert.equal(payload['h:List-Unsubscribe'], `<mailto:unsubscribe@mail.fixture.test>, <${oneClickUrl}>`);
  assert.equal(payload['h:List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
});

test('non-campaign transport remains unchanged when campaign preferences are absent', async () => {
  const html = '<main data-fixture="transactional">{{communication_preferences_link}}</main>';
  const text = 'Keep {{communication_preferences_url}}';
  const { payload } = await finalPayload({
    to: 'recipient@example.test',
    subject: 'Transactional fixture',
    html,
    text,
    tenantId: 'non-campaign-fixture',
    skipFooter: true,
    resolveTransactionalPreferences: false,
  });

  assert.equal(payload.html, html);
  assert.equal(payload.text, text);
  assert.equal(payload['h:List-Unsubscribe'], undefined);
  assert.equal(payload['h:List-Unsubscribe-Post'], undefined);
});

test('live, scheduled, tenant-test and group-test paths share the campaign transport contract', async () => {
  const sources = new Map(await Promise.all([
    ['live and scheduled worker', new URL('./campaignService.js', import.meta.url)],
    ['tenant test-send', new URL('../email-campaigns/test-send.js', import.meta.url)],
    ['group test-send', new URL('../member-campaigns/test-send.js', import.meta.url)],
  ].map(async ([name, url]) => [name, await readFile(url, 'utf8')])));

  const worker = sources.get('live and scheduled worker');
  assert.match(worker, /const designInfo = getCampaignEmailComposition\(campaign\)/);
  assert.match(worker, /campaignPreferences:\s*\{\s*preferencesUrl,/);
  assert.match(worker, /enableTracking:\s*true/);
  assert.match(worker, /unsubscribeUrl:\s*oneClickUnsubscribeUrl/);
  assert.match(worker, /processScheduledCampaigns[\s\S]*sendCampaign\(/);

  for (const name of ['tenant test-send', 'group test-send']) {
    const source = sources.get(name);
    assert.match(source, /getCampaignEmailComposition\(campaign\)/, `${name} uses shared composition`);
    assert.match(source, /campaignPreferences:\s*\{\s*[\s\S]*?preferencesUrl:\s*['"]#['"]/, `${name} renders non-actionable test preferences`);
    assert.doesNotMatch(source, /enableTracking:\s*true/, `${name} does not add production tracking headers`);
    assert.doesNotMatch(source, /unsubscribeUrl:\s*/, `${name} omits invalid one-click unsubscribe headers`);
  }
});