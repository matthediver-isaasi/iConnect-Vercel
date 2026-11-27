import test from 'node:test';
import assert from 'node:assert/strict';
import { handleSubmissionReply } from './send-submission-reply.js';
import { sendEmail, resolveDefaultSender, quoteSenderHeaders } from '../_lib/emailService.js';
import { wrapEmailFooter } from '../_lib/emailFooterLayout.js';

const actor = { id: 'actor-a', tenant_id: 'tenant-a', first_name: 'Alex', last_name: 'Example', email: 'alex@personal.test', role_id: 'role-a' };
const draft = { submission_id: 'submission-a', to: 'recipient@example.test', cc: 'cc@example.test', bcc: 'bcc@example.test', subject: 'Reply', html: '<p>Answer</p>' };
const config = { domain: 'mail.tenant.test', fromEmail: 'forms@mail.tenant.test', fromName: 'Tenant' };

async function invoke(options = {}) {
  const reads = [], history = [], calls = [], inbox = [], principals = [];
  const database = {
    from(table) {
      const filters = [];
      let inserted;
      const query = {
        select() { return query; },
        eq(key, value) { filters.push([key, value]); return query; },
        insert(value) { inserted = value; history.push(value); return query; },
        maybeSingle() { return query.single(); },
        async single() {
          reads.push({ table, filters });
          if (table === 'role') return { data: options.roleMissing ? null : { excluded_features: options.excluded || [] }, error: options.roleError };
          if (table === 'form_submission') return {
            data: options.submission === undefined ? { id: 'submission-a', tenant_id: 'tenant-a' } : options.submission,
            error: options.submissionError,
          };
          if (table === 'form_submission_email') return { data: { id: 'email-a', ...inserted }, error: options.insertError };
          throw new Error(`Unexpected table ${table}`);
        },
      };
      return query;
    },
  };
  const service = {
    defaultFrom: 'Platform <noreply@mail.platform.test>',
    defaultDomain: 'mail.platform.test',
    getTenantEmailConfig: async id => { assert.equal(id, 'tenant-a'); return options.fallback ? null : config; },
    getEmailFooter: async () => '<p>Tenant footer</p>',
    replaceSocialPlaceholdersInFooter: async value => value,
    resolveTransactionalPreferenceTokens: async payload => payload,
    recordTransactionalInboxMessage: async payload => { inbox.push(payload); },
    client: { messages: { async create(domain, message) {
      calls.push({ domain, message: structuredClone(message) });
      if (options.providerFailure) throw Object.assign(new Error('Rejected'), { status: 400 });
      return { id: '<mock-message>' };
    } } },
  };
  const res = {
    statusCode: 200, headers: {}, body: null,
    setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; },
  };
  const session = options.session === undefined ? { data: { tenantId: 'tenant-a', memberId: actor.id, ...(options.team ? { userType: 'tenant_user', tenantUserId: 'team-a' } : {}) } } : options.session;
  const identity = options.actor === undefined ? actor : options.actor;
  await handleSubmissionReply({
    method: options.method || 'POST', headers: options.headers || {},
    query: options.query || { submission_id: 'submission-a' }, body: options.body || draft,
  }, res, {
    database,
    getSession: async () => session,
    getSessionMember: async (_req, actualSession) => { assert.equal(actualSession, session); principals.push('member'); return identity; },
    getSessionTenantUser: async (_req, actualSession) => { assert.equal(actualSession, session); principals.push('team'); return identity; },
    resolveDefaultSender: id => resolveDefaultSender(id, service),
    quoteSenderHeaders: (id, sender) => quoteSenderHeaders(id, sender, service),
    buildInboxDelivery: async value => ({ ...value, memberId: 'recipient-member' }),
    sendEmail: value => sendEmail(value, service),
  });
  return { res, calls, history, inbox, reads, principals };
}

test('discovery shares exact verified/fallback default resolution and exposes only safe sender metadata', async () => {
  for (const fallback of [false, true]) {
    for (const team of [false, true]) {
      const result = await invoke({ method: 'GET', fallback, team });
      assert.equal(result.res.statusCode, 200);
      assert.equal(result.res.headers['Cache-Control'], 'private, no-store');
      assert.deepEqual(result.res.body, {
        defaultSender: fallback
          ? { email: 'noreply@mail.platform.test', from: 'Platform <noreply@mail.platform.test>' }
          : { email: config.fromEmail, from: 'Tenant <forms@mail.tenant.test>' },
        personalSender: { name: 'Alex Example', email: actor.email },
        personalUnavailableReason: null,
      });
      assert.deepEqual(result.principals, [team ? 'team' : 'member']);
      assert.deepEqual(result.calls, []);
      assert.deepEqual(result.history, []);
      assert.deepEqual(result.inbox, []);
      assert.deepEqual(result.reads[0].filters, [['id', 'role-a'], ['tenant_id', 'tenant-a']]);
    }
  }
});

test('default, omitted and self reach final transport with unchanged envelope, footer, inbox and actor audit', async () => {
  for (const fallback of [false, true]) {
    for (const team of [false, true]) {
      const results = [];
      for (const mode of [undefined, 'default', 'me']) {
        const result = await invoke({ fallback, team, body: { ...draft, ...(mode ? { senderMode: mode } : {}) } });
        assert.equal(result.res.statusCode, 200);
        assert.equal(result.calls.length, 1);
        assert.equal(result.calls[0].domain, fallback ? 'mail.platform.test' : config.domain);
        assert.deepEqual(result.calls[0].message, {
          from: mode === 'me'
            ? `"Alex Example" <${fallback ? 'noreply@mail.platform.test' : config.fromEmail}>`
            : fallback ? 'Platform <noreply@mail.platform.test>' : 'Tenant <forms@mail.tenant.test>',
          ...(mode === 'me' ? { 'h:Reply-To': actor.email } : {}),
          to: [draft.to], cc: [draft.cc], bcc: [draft.bcc], subject: draft.subject,
          html: draft.html + wrapEmailFooter('<p>Tenant footer</p>'),
          text: (draft.html + wrapEmailFooter('<p>Tenant footer</p>')).replace(/<[^>]*>/g, ''),
        });
        assert.equal(result.history[0].sent_by_email, actor.email);
        assert.equal(result.history[0].sent_by_member_id, team ? null : actor.id);
        assert.equal(result.history[0].body_html, draft.html);
        assert.equal(result.history[0].delivery_status, 'sent');
        assert.equal(result.inbox.length, 1);
        results.push(result);
      }
      assert.deepEqual(results[0].calls, results[1].calls);
      const { fromAddress: defaultFrom, ...defaultInbox } = results[1].inbox[0];
      const { fromAddress: selfFrom, ...selfInbox } = results[2].inbox[0];
      assert.deepEqual(defaultInbox, selfInbox);
      assert.equal(defaultFrom, results[1].calls[0].message.from);
      assert.equal(selfFrom, results[2].calls[0].message.from);
      assert.deepEqual(results[1].history, results[2].history);
    }
  }
});

test('missing personal details disable discovery and reject self without sending; default remains available', async () => {
  for (const changes of [
    { first_name: '', last_name: '' }, { email: '' }, { email: 'bad' },
    { email: 'deleted_abc@deleted.local' }, { email: 'x@example.test\r\nBcc: other@example.test' },
  ]) {
    const identity = { ...actor, ...changes };
    const discovery = await invoke({ method: 'GET', actor: identity });
    assert.equal(discovery.res.body.personalSender, null);
    assert.match(discovery.res.body.personalUnavailableReason, /name.*email/i);
    const self = await invoke({ actor: identity, body: { ...draft, senderMode: 'me' } });
    assert.equal(self.res.statusCode, 409);
    assert.equal(self.calls.length, 0);
    assert.equal(self.history.length, 0);
    assert.equal((await invoke({ actor: identity })).res.statusCode, 200);
  }
});

test('invalid modes and spoofed sender fields never send or create attempts', async () => {
  for (const changes of [
    { senderMode: 'self' }, { senderMode: null }, { senderMode: {} },
    { from: 'spoof@example.test' }, { replyTo: 'spoof@example.test' },
    { sender: actor }, { senderMode: 'me', tenantId: 'tenant-b' },
    { senderMode: 'me', personalSender: actor },
  ]) {
    const result = await invoke({ body: { ...draft, ...changes } });
    assert.equal(result.res.statusCode, 400);
    assert.equal(result.calls.length, 0);
    assert.equal(result.history.length, 0);
  }
});

test('discovery and sending share authentication, role and submission tenant boundaries', async () => {
  for (const method of ['GET', 'POST']) {
    for (const [overrides, status] of [
      [{ session: null }, 401], [{ actor: null }, 401],
      [{ actor: { ...actor, tenant_id: null } }, 403],
      [{ session: { data: { tenantId: 'tenant-b', memberId: actor.id } } }, 403],
      [{ headers: { 'x-tenant-id': 'tenant-b' } }, 403],
      [{ excluded: ['page_FormSubmissions'] }, 403],
      [{ excluded: ['page_FormManagement'] }, 403],
      [{ roleMissing: true }, 403], [{ roleError: { message: 'unavailable' } }, 403],
      [{ submission: { id: 'submission-a', tenant_id: 'tenant-b' } }, 403],
      [{ submission: null }, 404], [{ submissionError: { message: 'unavailable' } }, 500],
    ]) {
      const result = await invoke({ method, ...overrides });
      assert.equal(result.res.statusCode, status);
      assert.equal(result.calls.length, 0);
      assert.equal(result.history.length, 0);
      assert.equal(result.res.headers['Cache-Control'], 'private, no-store');
    }
  }
});

test('member and masquerade sessions never resolve preserved team sender authority', async () => {
  for (const data of [
    { userType: 'member', memberId: actor.id, preservedTenantUserId: 'team-a' },
    { userType: 'member', memberId: actor.id, tenantUserId: 'team-a' },
    { userType: 'tenant_user', memberId: actor.id, tenantUserId: 'team-a', isMasquerading: true },
  ]) {
    const result = await invoke({ method: 'GET', session: { data: { ...data, tenantId: 'tenant-a' } } });
    assert.deepEqual(result.principals, ['member']);
  }
});

test('failed deliveries keep existing failure recording and response for both sender modes', async () => {
  for (const senderMode of ['default', 'me']) {
    const result = await invoke({ body: { ...draft, senderMode }, providerFailure: true });
    assert.equal(result.res.statusCode, 502);
    assert.equal(result.calls.length, 1);
    assert.equal(result.inbox.length, 0);
    assert.equal(result.history[0].delivery_status, 'failed');
    assert.match(result.history[0].delivery_error, /Rejected/);
    assert.equal(result.res.body.record.sent_by_email, actor.email);
  }
});

test('accepted but unrecorded replies still report recording failure', async () => {
  const result = await invoke({ insertError: { message: 'unavailable' } });
  assert.equal(result.res.statusCode, 500);
  assert.match(result.res.body.error, /could not be recorded/);
  assert.equal(result.calls.length, 1);
});
