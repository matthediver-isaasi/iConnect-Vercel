import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { sendEmail } from '../_lib/emailService.js';
import { wrapEmailFooter } from '../_lib/emailFooterLayout.js';
import { handleCrmSend } from './send.js';

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    setHeader() {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; },
  };
}

function databaseFixture() {
  const history = [];
  return {
    history,
    from(table) {
      const query = {
        select() { return query; },
        eq() { return query; },
        maybeSingle() {
          return Promise.resolve({
            data: {
              id: 'member-a',
              tenant_id: 'tenant-a',
              email: 'Member@Example.test',
            },
            error: null,
          });
        },
        insert(value) {
          history.push(value);
          return Promise.resolve({ data: null, error: null });
        },
      };
      assert.ok(['member', 'member_email'].includes(table));
      return query;
    },
  };
}

function serviceDependencies(client) {
  return {
    client,
    defaultDomain: 'mail.iconn.test',
    defaultFrom: 'ICONN <noreply@mail.iconn.test>',
    getTenantEmailConfig: async tenantId => {
      assert.equal(tenantId, 'tenant-a');
      return {
        domain: 'mail.tenant.test',
        fromEmail: 'crm@mail.tenant.test',
        fromName: 'Tenant CRM',
      };
    },
    getEmailFooter: async tenantId => {
      assert.equal(tenantId, 'tenant-a');
      return '<p>Footer {{linkedin_url}}</p>';
    },
    replaceSocialPlaceholdersInFooter: async (footer, tenantId) => {
      assert.equal(tenantId, 'tenant-a');
      return footer.replace('{{linkedin_url}}', 'https://example.test/tenant');
    },
    resolveTransactionalPreferenceTokens: async payload => ({
      ...payload,
      subject: `Resolved ${payload.subject}`,
      html: `${payload.html}<p>Preference resolved</p>`,
      text: `${payload.text}|preference-resolved`,
    }),
  };
}

async function invoke({ cc, create }) {
  const calls = [];
  const client = {
    messages: {
      async create(domain, envelope) {
        calls.push({ domain, envelope: structuredClone(envelope) });
        return create({ domain, envelope, callNumber: calls.length });
      },
    },
  };
  const database = databaseFixture();
  const res = responseRecorder();
  await handleCrmSend(
    {
      method: 'POST',
      headers: { 'x-tenant-id': 'tenant-a' },
      body: {
        memberId: 'member-a',
        tenantId: 'tenant-a',
        to: 'member@example.test',
        ...(cc === undefined ? {} : { cc }),
        subject: 'Subject',
        body: 'Line <one>',
        bodyType: 'text',
      },
    },
    res,
    {
      database,
      getTenantContext: async () => ({ isAuthenticated: true, tenantId: 'tenant-a' }),
      hasAdminAccess: async () => true,
      getSession: async () => ({ data: { tenantId: 'tenant-a', identityId: 'identity-a' } }),
      sendEmail: options => sendEmail(options, serviceDependencies(client)),
    },
  );
  return { calls, database, res };
}

test('CRM route reaches the real Mailgun orchestration with exact rendered envelopes and CC shapes', async () => {
  const footer = wrapEmailFooter('<p>Footer https://example.test/tenant</p>');
  const expectedBase = {
    from: 'Tenant CRM <crm@mail.tenant.test>',
    to: ['Member@Example.test'],
    subject: 'Resolved Subject',
    html: `<div style="white-space: pre-wrap;">Line &lt;one&gt;</div>${footer}<p>Preference resolved</p>`,
    text: 'Line <one>|preference-resolved',
  };

  const noCc = await invoke({
    create: async () => ({ id: '<no-cc@mailgun.test>' }),
  });
  assert.equal(noCc.res.statusCode, 200);
  assert.deepEqual(noCc.calls, [{
    domain: 'mail.tenant.test',
    envelope: expectedBase,
  }]);
  assert.equal(noCc.database.history[0].subject, expectedBase.subject);
  assert.equal(noCc.database.history[0].body_content, expectedBase.html);
  assert.equal(noCc.database.history[0].from_address, 'crm@mail.tenant.test');

  const multipleCc = await invoke({
    cc: 'one@example.test; two@example.test',
    create: async () => ({ id: '<multi-cc@mailgun.test>' }),
  });
  assert.deepEqual(multipleCc.calls, [{
    domain: 'mail.tenant.test',
    envelope: {
      ...expectedBase,
      cc: ['one@example.test', 'two@example.test'],
    },
  }]);
  assert.deepEqual(
    multipleCc.database.history[0].cc_addresses,
    [
      { address: 'one@example.test', name: null },
      { address: 'two@example.test', name: null },
    ],
  );
});

test('explicit tenant-domain rejection falls back once and records the actual fallback From', async () => {
  const result = await invoke({
    create: async ({ callNumber }) => {
      if (callNumber === 1) {
        const error = new Error('Unauthorized');
        error.status = 401;
        throw error;
      }
      return { id: '<fallback@mailgun.test>' };
    },
  });
  assert.equal(result.res.statusCode, 200);
  assert.equal(result.calls.length, 2);
  assert.equal(result.calls[0].domain, 'mail.tenant.test');
  assert.equal(result.calls[0].envelope.from, 'Tenant CRM <crm@mail.tenant.test>');
  assert.equal(result.calls[1].domain, 'mail.iconn.test');
  assert.equal(result.calls[1].envelope.from, 'ICONN <noreply@mail.iconn.test>');
  assert.equal(result.res.body.provider.fallback, true);
  assert.equal(result.res.body.provider.domain, 'mail.iconn.test');
  assert.equal(result.res.body.provider.fromAddress, 'ICONN <noreply@mail.iconn.test>');
  assert.equal(result.database.history[0].from_address, 'noreply@mail.iconn.test');
  assert.equal(result.database.history[0].from_name, 'ICONN');
});

test('ambiguous Mailgun transport failure never falls back or writes history', async () => {
  const result = await invoke({
    create: async () => {
      const error = new Error('ECONNRESET after request write');
      error.code = 'ECONNRESET';
      throw error;
    },
  });
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].domain, 'mail.tenant.test');
  assert.equal(result.res.statusCode, 502);
  assert.equal(result.res.body.code, 'MAILGUN_DELIVERY_UNKNOWN');
  assert.equal(result.res.body.deliveryUnknown, true);
  assert.deepEqual(result.database.history, []);
});

test('CRM Mailgun path has no Outlook or Microsoft Graph dependency', () => {
  const sources = [
    readFileSync(new URL('./send.js', import.meta.url), 'utf8'),
    readFileSync(new URL('../_lib/emailService.js', import.meta.url), 'utf8'),
  ].join('\n');
  assert.doesNotMatch(
    sources,
    /^\s*import\b[^\n]*(?:outlook|microsoftGraph)|graph\.microsoft\.com/mi,
  );
});