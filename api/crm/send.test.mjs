import assert from 'node:assert/strict';
import test from 'node:test';
import { handleCrmSend } from './send.js';
import { handleMemberEmailHistory } from '../outlook/emails/[memberId].js';

function responseRecorder() {
  return {
    statusCode: 200, body: null,
    setHeader() {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; },
  };
}

function databaseFixture({ member, memberError = null, logError = null, throwOnLog = false } = {}) {
  const operations = [];
  return {
    operations,
    from(table) {
      const filters = [];
      const query = {
        select() { return query; },
        eq(column, value) { filters.push([column, value]); return query; },
        maybeSingle() {
          operations.push({ table, kind: 'read', filters: [...filters] });
          return Promise.resolve({ data: member, error: memberError });
        },
        insert(value) {
          operations.push({ table, kind: 'insert', value });
          if (throwOnLog) throw new Error('write failed');
          return Promise.resolve({ data: null, error: logError });
        },
      };
      return query;
    },
  };
}

const member = { id: 'member-a', tenant_id: 'tenant-a', email: 'Member@Example.com' };
const body = {
  memberId: 'member-a', tenantId: 'tenant-a', to: 'member@example.com',
  cc: 'copy@example.net', subject: 'Hello', body: 'Message', bodyType: 'text',
};

async function invoke(overrides = {}) {
  const database = databaseFixture({
    member: overrides.member === undefined ? member : overrides.member,
    memberError: overrides.memberError,
    logError: overrides.logError,
    throwOnLog: overrides.throwOnLog,
  });
  const deliveries = [];
  const res = responseRecorder();
  await handleCrmSend(
    {
      method: 'POST',
      headers: overrides.headers || { 'x-tenant-id': 'tenant-a' },
      body: overrides.body || body,
    },
    res,
    {
      database,
      getTenantContext: async () => overrides.context || ({
        isAuthenticated: true, tenantId: 'tenant-a',
      }),
      hasAdminAccess: async () => overrides.admin !== false,
      getSession: async () => ({
        data: overrides.session || { tenantId: 'tenant-a', identityId: 'identity-a' },
      }),
      sendEmail: async envelope => {
        deliveries.push(envelope);
        if (overrides.deliveryError) throw overrides.deliveryError;
        return overrides.delivery || {
          success: true,
          provider: 'mailgun',
          messageId: '<provider-id>',
          domain: 'mail.tenant.test',
          fromAddress: 'Tenant Name <noreply@mail.tenant.test>',
          renderedSubject: 'Rendered Hello',
          renderedHtml: '<div>Message</div><footer>Tenant footer</footer>',
          renderedText: 'Message',
        };
      },
    },
  );
  return { database, deliveries, res };
}

test('tenant-scoped admin send uses server member address and records Mailgun metadata', async () => {
  const { res, database, deliveries } = await invoke();
  assert.equal(res.statusCode, 200);
  assert.equal(deliveries.length, 1);
  assert.deepEqual(deliveries[0], {
    to: 'Member@Example.com',
    cc: ['copy@example.net'],
    subject: 'Hello',
    text: 'Message',
    html: '<div style="white-space: pre-wrap;">Message</div>',
    tenantId: 'tenant-a',
    includeRenderedContent: true,
  });
  const history = database.operations.find(op => op.table === 'member_email');
  assert.equal(history.value.microsoft_message_id, null);
  assert.equal(history.value.email_provider, 'mailgun');
  assert.equal(history.value.provider_message_id, '<provider-id>');
  assert.equal(history.value.from_address, 'noreply@mail.tenant.test');
  assert.equal(history.value.from_name, 'Tenant Name');
  assert.equal(history.value.subject, 'Rendered Hello');
  assert.equal(history.value.body_content, '<div>Message</div><footer>Tenant footer</footer>');
  assert.equal(history.value.body_content_type, 'html');
  assert.equal(history.value.body_preview, 'Message');
  assert.equal(history.value.synced_by_identity_id, null);
  assert.deepEqual(res.body.provider, {
    provider: 'mailgun',
    messageId: '<provider-id>',
    domain: 'mail.tenant.test',
    fromAddress: 'Tenant Name <noreply@mail.tenant.test>',
    fallback: false,
  });
});

test('rich member email preserves formatting but strips active markup, unsafe URLs and CSS', async () => {
  const rich = '<h2>News</h2><p onclick="steal()"><strong>Hello</strong> <em>friend</em> '
    + '<a href="https://example.test/info" style="background:url(https://tracker.test/a)">Details</a> '
    + '<a href="javascript:alert(1)">Unsafe</a></p><script>alert(2)</script>'
    + '<ul><li>First</li><li>Second</li></ul><img src=x onerror="steal()">';
  const { res, deliveries, database } = await invoke({
    body: { ...body, body: rich, bodyType: 'html' },
  });
  assert.equal(res.statusCode, 200);
  const sent = deliveries[0];
  assert.equal(sent.includeRenderedContent, true);
  assert.match(sent.html, /<h2>News<\/h2>/);
  assert.match(sent.html, /<strong>Hello<\/strong>/);
  assert.match(sent.html, /<em>friend<\/em>/);
  assert.match(sent.html, /href="https:\/\/example.test\/info"/);
  assert.match(sent.html, /<ul><li>First<\/li><li>Second<\/li><\/ul>/);
  assert.doesNotMatch(sent.html, /script|onclick|onerror|javascript:|<img|style=|tracker\.test/);
  assert.match(sent.text, /Hello friend Details \(https:\/\/example.test\/info\) Unsafe/);
  const history = database.operations.find(op => op.table === 'member_email').value;
  assert.equal(history.body_content, '<div>Message</div><footer>Tenant footer</footer>');
  assert.equal(history.body_preview, 'Message');
  assert.equal(res.body.renderedHtml, undefined);
  assert.equal(res.body.renderedText, undefined);
});

test('rich drafts without visible content are rejected before provider delivery', async () => {
  for (const empty of [
    '<p></p>',
    '<p><br></p>',
    '<p>&nbsp;&#x200b;&#8203;&#x2060;&lrm;&shy;&#xFE0F;</p>',
    '<script>alert("hidden")</script><img src="https://example.test/a">',
    '<a href="https://example.test"></a>',
  ]) {
    const { res, deliveries, database } = await invoke({
      body: { ...body, body: empty, bodyType: 'html' },
    });
    assert.equal(res.statusCode, 400, empty);
    assert.match(res.body.error, /body/i);
    assert.equal(deliveries.length, 0);
    assert.equal(database.operations.some(op => op.table === 'member_email'), false);
  }
});

test('records the actual fallback domain and sender returned by Mailgun service', async () => {
  const { res, database } = await invoke({
    delivery: {
      success: true,
      provider: 'mailgun',
      messageId: '<fallback-id>',
      domain: 'mail.iconn.app',
      fromAddress: 'ICONN <noreply@mail.iconn.app>',
      fallback: true,
    },
  });
  const history = database.operations.find(op => op.table === 'member_email');
  assert.equal(history.value.email_provider, 'mailgun');
  assert.equal(history.value.provider_message_id, '<fallback-id>');
  assert.equal(history.value.from_address, 'noreply@mail.iconn.app');
  assert.equal(history.value.from_name, 'ICONN');
  assert.equal(res.body.provider.domain, 'mail.iconn.app');
  assert.equal(res.body.provider.fromAddress, 'ICONN <noreply@mail.iconn.app>');
  assert.equal(res.body.provider.fallback, true);
});

test('an accepted Mailgun history row is visible through the existing tenant ACL handler', async () => {
  const rows = [];
  const database = {
    from(table) {
      const filters = [];
      const query = {
        select() { return query; },
        eq(column, value) { filters.push([column, value]); return query; },
        order() { return query; },
        in() { return query; },
        maybeSingle() {
          return Promise.resolve({
            data: table === 'member' ? member : null,
            error: null,
          });
        },
        insert(value) {
          rows.push({ id: 'history-a', ...value });
          return Promise.resolve({ data: null, error: null });
        },
        limit() {
          return Promise.resolve({
            data: table === 'member_email'
              ? rows.filter(row => filters.every(([key, value]) => row[key] === value))
              : [],
            error: null,
          });
        },
      };
      return query;
    },
  };
  const sendRes = responseRecorder();
  await handleCrmSend(
    { method: 'POST', headers: { 'x-tenant-id': 'tenant-a' }, body },
    sendRes,
    {
      database,
      getTenantContext: async () => ({ isAuthenticated: true, tenantId: 'tenant-a' }),
      hasAdminAccess: async () => true,
      getSession: async () => ({ data: { tenantId: 'tenant-a' } }),
      sendEmail: async () => ({
        success: true,
        provider: 'mailgun',
        messageId: '<visible-id>',
        domain: 'mail.iconn.app',
        fromAddress: 'ICONN <noreply@mail.iconn.app>',
        renderedSubject: 'Visible subject',
        renderedHtml: '<p>Visible rendered body</p>',
        renderedText: 'Visible rendered body',
      }),
    },
  );
  assert.equal(sendRes.statusCode, 200);

  const historyRes = responseRecorder();
  await handleMemberEmailHistory(
    {
      method: 'GET',
      headers: { 'x-tenant-id': 'tenant-a' },
      query: { memberId: 'member-a' },
    },
    historyRes,
    {
      database,
      getTenantContext: async () => ({ isAuthenticated: true, tenantId: 'tenant-a' }),
      hasAdminAccess: async () => true,
      getAgentEmailsForTenant: async () => new Set(),
      getOrgMapForTenant: async () => new Map(),
    },
  );
  assert.equal(historyRes.statusCode, 200);
  assert.equal(historyRes.body.emails.length, 1);
  assert.equal(historyRes.body.emails[0].email_provider, 'mailgun');
  assert.equal(historyRes.body.emails[0].provider_message_id, '<visible-id>');
  assert.equal(historyRes.body.emails[0].subject, 'Visible subject');
  assert.equal(historyRes.body.emails[0].body_content, '<p>Visible rendered body</p>');
});

test('authorization and stale-recipient failures cannot reach Mailgun', async () => {
  const cases = [
    { admin: false, status: 403 },
    { headers: {}, status: 403 },
    { body: { ...body, tenantId: 'tenant-b' }, status: 403 },
    { body: { ...body, to: 'stale@example.test' }, status: 409 },
    { member: { ...member, email: 'deleted_x@deleted.local' }, status: 404 },
    { body: { ...body, cc: 'bad-address' }, status: 400 },
    { body: { ...body, subject: 'Hello\r\nBcc: bad@example.test' }, status: 400 },
    { body: { ...body, saveToSentItems: true }, status: 400 },
  ];
  for (const item of cases) {
    const { res, deliveries } = await invoke(item);
    assert.equal(res.statusCode, item.status);
    assert.equal(deliveries.length, 0);
  }
});

test('ambiguous delivery, rejection, and accepted-but-unlogged are distinct', async () => {
  const thrown = await invoke({ deliveryError: new Error('socket reset') });
  assert.equal(thrown.res.statusCode, 502);
  assert.equal(thrown.res.body.deliveryUnknown, true);
  assert.equal(thrown.res.body.code, 'MAILGUN_DELIVERY_UNKNOWN');
  assert.equal(thrown.deliveries.length, 1);
  assert.equal(thrown.database.operations.some(op => op.table === 'member_email'), false);

  const unknown = await invoke({
    delivery: {
      success: false, ambiguousEffect: true, provider: 'mailgun',
      domain: 'mail.tenant.test', fromAddress: 'noreply@mail.tenant.test',
    },
  });
  assert.equal(unknown.res.statusCode, 502);
  assert.equal(unknown.res.body.deliveryUnknown, true);
  assert.equal(unknown.res.body.code, 'MAILGUN_DELIVERY_UNKNOWN');
  assert.equal(unknown.database.operations.some(op => op.table === 'member_email'), false);

  const rejected = await invoke({
    delivery: {
      success: false, ambiguousEffect: false, provider: 'mailgun',
      domain: 'mail.tenant.test', fromAddress: 'noreply@mail.tenant.test',
    },
  });
  assert.equal(rejected.res.statusCode, 502);
  assert.equal(rejected.res.body.deliveryUnknown, false);
  assert.equal(rejected.res.body.code, 'MAILGUN_REJECTED');

  const unlogged = await invoke({ logError: { message: 'database unavailable' } });
  assert.equal(unlogged.res.statusCode, 200);
  assert.equal(unlogged.res.body.success, true);
  assert.match(unlogged.res.body.warning, /history/i);
  assert.equal(unlogged.res.body.deliveryUnknown, false);
  assert.equal(unlogged.res.body.provider.messageId, '<provider-id>');
});