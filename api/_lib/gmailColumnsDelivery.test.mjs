import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import Mailgun from 'mailgun.js';
import { register } from 'tsx/esm/api';

assert.equal(
  process.env.TEST_ISOLATION_ACTIVE,
  '1',
  'Run with scripts/run-isolated-tests.mjs so this transport regression cannot use the network',
);

process.env.MAILGUN_API_KEY = 'mock-gmail-columns-key';
process.env.APP_DOMAIN = 'example.test';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://fixture.example.test/',
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.navigator = dom.window.navigator;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Element = dom.window.Element;
globalThis.Node = dom.window.Node;

const transportCalls = [];
const originalMailgunClient = Mailgun.prototype.client;
Mailgun.prototype.client = () => ({
  messages: {
    create: async (domain, payload) => {
      transportCalls.push({ domain, payload });
      return { id: `<mock-gmail-columns-${transportCalls.length}>` };
    },
  },
});

// Use a scoped loader only for the client module's extensionless imports, then
// explicitly deactivate its MessagePort so plain `node --test` can terminate.
const handlesBeforeTsxRegistration = new Set(process._getActiveHandles());
const unregisterTsx = register({ namespace: 'gmail-columns-delivery' });
const { designToHtml } = await unregisterTsx.import(
  '../../client/src/components/email-builder/mjmlConverter.js',
  import.meta.url,
);
await unregisterTsx();

const [
  { rewriteLinksForTracking, applyDynamicSlotValues: replaceCampaignSlotValues },
  { sendEmail },
  { supabase },
] = await Promise.all([
  import('./campaignService.js'),
  import('./emailService.js'),
  import('./database.js'),
]);

const originalFrom = supabase.from;
const queriedTables = [];
const tenantFooter = [
  '<table data-fixture="send-email-default-footer" width="900">',
  '<tr><td><img src="https://images.example.test/default-footer.png" width="900"></td></tr>',
  '<tr><td><a href="{{unsubscribe_link}}">Default preferences</a></td></tr>',
  '</table>',
].join('');

supabase.from = (table) => {
  queriedTables.push(table);
  const filters = new Map();
  const query = {
    select() { return query; },
    eq(column, value) {
      filters.set(column, value);
      return query;
    },
    async single() {
      if (table === 'tenant') {
        return {
          data: {
            id: filters.get('id'),
            name: 'Gmail Columns Fixture',
            slug: 'gmail-columns',
            settings: {
              email_domain: {
                status: 'verified',
                domain: 'mail.fixture.test',
                from_email: 'news@mail.fixture.test',
                from_name: 'Gmail Columns Fixture',
              },
            },
          },
          error: null,
        };
      }
      if (table === 'system_settings') {
        if (filters.get('setting_key') === 'email_footer_html') {
          return { data: { setting_value: tenantFooter }, error: null };
        }
        if (filters.get('setting_key') === 'social_icons_config') {
          return { data: null, error: null };
        }
      }
      throw new Error(`Unexpected Gmail columns fixture query: ${table}`);
    },
  };
  return query;
};

after(() => {
  supabase.from = originalFrom;
  Mailgun.prototype.client = originalMailgunClient;
  dom.window.close();
  // tsx's scoped registration deactivates asynchronously and, on Node 20, can
  // leave its newly-created loader port referenced after unregister resolves.
  // Only unref the port introduced by this test; do not disturb runner handles.
  for (const handle of process._getActiveHandles()) {
    if (
      !handlesBeforeTsxRegistration.has(handle)
      && handle.constructor?.name === 'MessagePort'
    ) {
      handle.unref();
    }
  }
});

const builderFooter = [
  '<table data-fixture="builder-footer" width="720" style="width:720px">',
  '<tr><td>Builder footer <a href="https://fixture.example.test/email-preferences?t=visual">Preferences</a></td></tr>',
  '</table>',
].join('');

const design = {
  globalStyles: {
    contentWidth: '640px',
    backgroundColor: '#edf1f5',
    contentBackgroundColor: '#ffffff',
    contentPadding: '0px',
    useDefaultFooter: true,
  },
  blocks: [{
    id: 'gmail-columns',
    type: 'columns',
    styles: {
      backgroundColor: '#ffffff',
      columnGap: '16px',
      paddingTop: '12',
      paddingRight: '16',
      paddingBottom: '12',
      paddingLeft: '16',
    },
    columns: [{
      id: 'left',
      width: '50%',
      backgroundColor: '#fff4e8',
      blocks: [
        {
          id: 'left-image',
          type: 'image',
          src: 'https://images.example.test/left-card.png',
          alt: 'Left card',
          styles: { paddingTop: '0', paddingRight: '0', paddingBottom: '8', paddingLeft: '0' },
        },
        {
          id: 'left-copy',
          type: 'dynamic_text',
          token: 'card_copy',
          styles: { color: '#243042', lineHeight: '1.4', paddingTop: '0', paddingRight: '0', paddingBottom: '8', paddingLeft: '0' },
        },
      ],
    }, {
      id: 'right',
      width: '50%',
      backgroundColor: '#eaf6ff',
      blocks: [{
        id: 'right-button',
        type: 'button',
        content: 'Open candidate',
        href: 'https://destination.example.test/candidate?source=email&card=right',
        styles: {
          backgroundColor: '#0b5fff',
          color: '#ffffff',
          fontSize: '16px',
          fontWeight: '700',
          borderRadius: '8px',
          textAlign: 'center',
          innerPaddingTop: '12',
          innerPaddingRight: '20',
          innerPaddingBottom: '12',
          innerPaddingLeft: '20',
          paddingTop: '10',
          paddingRight: '0',
          paddingBottom: '10',
          paddingLeft: '0',
        },
      }],
    }],
  }],
};

function normalizeExpectedDeliveryChanges(html) {
  return html
    .replace(/(<a\b[^>]*\bhref=)(["'])[\s\S]*?\2/gi, '$1$2[expected-href]$2')
    .replace(/<table\b[^>]*data-fixture=(["'])builder-footer\1[^>]*>[\s\S]*?<\/table>/gi, '[expected-builder-footer]');
}

test('Gmail transport keeps hybrid visual-builder columns intact after slots, tracking, and sendEmail', async () => {
  const generated = designToHtml(design, {
    footerHtml: builderFooter,
  });
  assert.ok(generated, 'visual builder produced candidate HTML');

  const withSlots = replaceCampaignSlotValues(generated, {
    card_copy: '<strong>Candidate spotlight</strong>',
  }, {
    html: true,
    richSlots: ['card_copy'],
  });
  assert.match(withSlots, /<strong>Candidate spotlight<\/strong>/);

  const tracked = rewriteLinksForTracking(
    withSlots,
    'campaign-columns-fixture',
    'recipient-columns-fixture',
    'gmail-columns',
    'fixture.example.test',
  );
  assert.match(tracked, /\/api\/track\/click\?t=/);
  assert.match(tracked, /source%3Demail%26card%3Dright/);

  const before = transportCalls.length;
  const result = await sendEmail({
    to: 'recipient@example.test',
    subject: 'Gmail columns delivery fixture',
    html: tracked,
    tenantId: 'gmail-columns-visual-footer',
    skipFooter: true,
    contentWidth: '640px',
    resolveTransactionalPreferences: false,
  });
  assert.equal(result.success, true);
  assert.equal(transportCalls.length, before + 1);

  const { domain, payload } = transportCalls.at(-1);
  assert.equal(domain, 'mail.fixture.test');
  assert.equal(
    normalizeExpectedDeliveryChanges(payload.html),
    normalizeExpectedDeliveryChanges(withSlots),
    'transport changes no candidate markup other than the expected tracked hrefs/footer exclusion',
  );

  // MJML's responsive column CSS and Outlook conditional table scaffolding are
  // both needed by the hybrid candidate; neither may be stripped at transport.
  assert.match(payload.html, /@media only screen and \(min-width:480px\)/i);
  assert.match(payload.html, /\.mj-column-per-50/i);
  assert.match(payload.html, /\[if mso \| IE\]><table/i);
  assert.match(payload.html, /background-color:\s*#fff4e8/i);
  assert.match(payload.html, /background-color:\s*#eaf6ff/i);
  assert.match(payload.html, /bgcolor="#0b5fff"/i);
  assert.match(payload.html, /background-color:#0b5fff\s*!important/i);
  assert.match(payload.html, /src="https:\/\/images\.example\.test\/left-card\.png"/i);
  assert.match(payload.html, /data-fixture="builder-footer"/);
  assert.doesNotMatch(payload.html, /data-fixture="send-email-default-footer"/);
});

for (const footerWidth of [500, 600, 700]) {
test(`sendEmail appends a responsive ${footerWidth}px footer with an Outlook desktop wrapper`, async () => {
  const body = designToHtml({
    ...design,
    globalStyles: { ...design.globalStyles, useDefaultFooter: false },
  }, {
  });

  const result = await sendEmail({
    to: 'recipient@example.test',
    subject: 'Default footer fixture',
    html: body,
    tenantId: 'gmail-columns-default-footer',
    skipFooter: false,
    contentWidth: `${footerWidth}px`,
    resolveTransactionalPreferences: false,
  });
  assert.equal(result.success, true);

  const { payload } = transportCalls.at(-1);
  assert.match(payload.html, /data-fixture="send-email-default-footer"/);
  assert.doesNotMatch(payload.html, /data-fixture="builder-footer"/);
  assert.ok(payload.html.includes(`<!--[if mso]><table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" width="${footerWidth}" style="width:${footerWidth}px;"><tr><td><![endif]-->`));
  assert.ok(payload.html.includes(`width="100%" style="width:100%;max-width:${footerWidth}px;margin:0 auto;"`));
  assert.match(payload.html, /max-width:\s*100%;\s*width:\s*100%/i);
  assert.match(payload.html, /max-width:\s*100%;\s*height:\s*auto/i);

  assert.match(payload.html, /<!--\[if mso\]><\/td><\/tr><\/table><!\[endif\]-->/);
  assert.ok(queriedTables.every((table) => table === 'tenant' || table === 'system_settings'));
  assert.ok(!queriedTables.includes('campaign'));
  assert.ok(!queriedTables.includes('contacts'));
});
}