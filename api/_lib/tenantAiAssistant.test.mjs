import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  validateMemberAiAssistant,
  resolveMemberAiAssistant,
  loadTenantAiAssistant,
  loadTenantAiAssistantConfig,
  requireTenantAiAssistant,
} from './tenantAiAssistant.js';

function database(settings, { readError = null, persona = null, personaError = null } = {}) {
  const reads = [];
  return {
    reads,
    from(table) {
      const query = {
        select() { return query; },
        eq(key, value) { reads.push([table, key, value]); return query; },
        async single() {
          return { data: readError ? null : { settings }, error: readError };
        },
        async maybeSingle() {
          return { data: persona ? { value: persona } : null, error: personaError };
        },
      };
      return query;
    },
  };
}

function response() {
  return {
    statusCode: 200,
    setHeader() {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('inherits platform name and avatar but only uses tenant description overrides', async () => {
  const db = database({ member_ai_assistant: { enabled: true, name: '', avatarUrl: '', backgroundColor: '' } }, {
    persona: { name: 'Bert', avatarUrl: 'https://example.org/bert.png', description: 'Helpful' },
  });
  assert.deepEqual(await loadTenantAiAssistantConfig('tenant-a', db), {
    tenantId: 'tenant-a', enabled: true, name: 'Bert',
    avatarUrl: 'https://example.org/bert.png', description: '',
    backgroundColor: '',
    overrides: { enabled: true, name: '', avatarUrl: '', description: '', backgroundColor: '' },
  });
  assert.deepEqual(db.reads, [
    ['tenant', 'id', 'tenant-a'], ['platform_preferences', 'key', 'ai_help_persona'],
  ]);
  assert.equal((await loadTenantAiAssistant('tenant-b', database({}))).enabled, true);
  assert.equal(resolveMemberAiAssistant('t', null).name, 'Dougal');
  assert.equal(resolveMemberAiAssistant('t', null, { description: 'Platform text' }).description, '');
  assert.equal(resolveMemberAiAssistant('t', null).overrides.enabled, true);
  assert.equal(resolveMemberAiAssistant('t', { member_ai_assistant: { name: 'Partial' } }).enabled, true);
  assert.equal(resolveMemberAiAssistant('t', { member_ai_assistant: { name: 'Partial' } }).name, 'Partial');
  assert.equal(resolveMemberAiAssistant('t', { member_ai_assistant: { description: 'Tenant text' } },
    { description: 'Platform text' }).description, 'Tenant text');
  assert.equal(resolveMemberAiAssistant('t', { member_ai_assistant: { description: 12 } },
    { description: 'Platform text' }).description, '');
  assert.equal(resolveMemberAiAssistant('t', { member_ai_assistant: { description: 'x'.repeat(501) } },
    { description: 'Platform text' }).description, '');
  assert.equal(resolveMemberAiAssistant('t', { member_ai_assistant: { enabled: 'true' } }).enabled, false);
});

test('validates types, colours, URLs, name and description; allows resets and uploaded HTTPS URLs', () => {
  assert.deepEqual(validateMemberAiAssistant({
    enabled: false, name: '', avatarUrl: 'https://storage.example.org/file.png',
    description: '  Helpful\tassistant\nfor members  ', backgroundColor: '#aBc123',
  }), {
    enabled: false, name: '', avatarUrl: 'https://storage.example.org/file.png',
    description: 'Helpful\tassistant\nfor members', backgroundColor: '#aBc123',
  });
  assert.deepEqual(validateMemberAiAssistant({ avatarUrl: '/uploads/photo.png', backgroundColor: '' }), {
    avatarUrl: '/uploads/photo.png', backgroundColor: '',
  });
  assert.equal(validateMemberAiAssistant({ description: 'x'.repeat(500) }).description, 'x'.repeat(500));
  assert.equal(validateMemberAiAssistant({ description: ' \n' }).description, '');
  for (const bad of [
    null, [], { enabled: 'false' }, { name: 1 }, { avatarUrl: null },
    { description: null }, { description: 'x'.repeat(501) },
    { description: `${' '.repeat(500)}x` },
    { description: 'bad\u0000text' }, { description: 'bad\u0008text' },
    { description: 'bad\u007ftext' }, { description: 'bad\u0085text' },
    { avatarUrl: 'javascript:alert(1)' }, { avatarUrl: 'data:image/svg+xml,x' },
    { avatarUrl: '//evil.test/x' }, { avatarUrl: 'http://evil.test/x' },
    { avatarUrl: 'https://user:pass@evil.test/x' }, { avatarUrl: 'https://evil.test\\@trusted.test/x' },
    { backgroundColor: '#fff' }, { backgroundColor: 'red' },
  ]) assert.throws(() => validateMemberAiAssistant(bad));
});

test('tenant read failures refuse access, and disabled admin preview is denied', async () => {
  for (const [db, status] of [
    [database(null, { readError: new Error('network') }), 503],
    [database({ member_ai_assistant: { enabled: false } }), 403],
  ]) {
    const res = response();
    assert.equal(await requireTenantAiAssistant('tenant-a', res, db), false);
    assert.equal(res.statusCode, status);
  }
  const db = database({ member_ai_assistant: { enabled: true } });
  assert.equal(await requireTenantAiAssistant('tenant-a', response(), db), true);
  assert.equal(await requireTenantAiAssistant('tenant-a', response(), database({})), true);
  await assert.rejects(() => loadTenantAiAssistantConfig('tenant-a',
    database({}, { personaError: new Error('unavailable') })));
});

test('admin PATCH merges assistant fields, preserves unrelated nested settings and rejects invalid payloads', async () => {
  const source = readFileSync(new URL('../admin/tenant.js', import.meta.url), 'utf8')
    .replace(/^import .*;$/gm, '')
    .replace('export default async function handler', 'async function handler');
  const state = {
    settingsByTenant: {
      'tenant-a': {
        untouched: 1, email_domain: { from_name: 'Old' },
        member_ai_assistant: { enabled: true, name: 'Original', futureField: 'keep' },
      },
      'tenant-b': { member_ai_assistant: { enabled: true, name: 'Other tenant' } },
    },
    updated: null, failRead: false, user: { tenant_id: 'tenant-a' },
  };
  const db = {
    from(table) {
      assert.equal(table, 'tenant');
      let tenantId;
      let pendingUpdate = null;
      const q = {
        select() { return q; },
        eq(key, value) {
          assert.equal(key, 'id');
          tenantId = value;
          if (pendingUpdate) state.settingsByTenant[tenantId] = pendingUpdate.settings;
          return q;
        },
        update(value) {
          state.updated = value;
          pendingUpdate = value;
          return q;
        },
        async single() {
          if (state.updated) return { data: { ...state.updated, slug: null, domain: null }, error: null };
          return state.failRead ? { data: null, error: Error('read failure') } :
            { data: { settings: state.settingsByTenant[tenantId] }, error: null };
        },
      };
      return q;
    },
  };
  const handler = new Function('getSessionTenantUser', 'supabase', 'clearTenantCache',
    'clearTenantEmailCache', 'validateMemberAiAssistant', `${source}\nreturn handler;`)(
      async () => state.user, db, () => {}, () => {}, validateMemberAiAssistant);
  const patch = async settings => {
    state.updated = null;
    const res = response();
    await handler({ method: 'PATCH', headers: {}, body: { settings } }, res);
    return res;
  };
  let res = await patch({ member_ai_assistant: { enabled: false, name: '', description: '  Tenant A help  ' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(state.updated.settings.member_ai_assistant,
    { enabled: false, name: '', description: 'Tenant A help', futureField: 'keep' });
  assert.equal(state.updated.settings.untouched, 1);
  assert.deepEqual(state.updated.settings.email_domain, { from_name: 'Old' });
  res = await patch({ member_ai_assistant: { avatarUrl: '/uploads/a.png' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(state.updated.settings.member_ai_assistant,
    { enabled: false, name: '', description: 'Tenant A help', avatarUrl: '/uploads/a.png', futureField: 'keep' });
  state.user = { tenant_id: 'tenant-b' };
  res = await patch({ member_ai_assistant: { description: 'Tenant B help' } });
  assert.equal(res.statusCode, 200);
  assert.equal(state.settingsByTenant['tenant-b'].member_ai_assistant.description, 'Tenant B help');
  assert.equal(state.settingsByTenant['tenant-a'].member_ai_assistant.description, 'Tenant A help');
  state.user = { tenant_id: 'tenant-a' };
  res = await patch({ member_ai_assistant: { avatarUrl: 'javascript:alert(1)' } });
  assert.equal(res.statusCode, 400);
  assert.equal(state.updated, null);
  res = await patch({ member_ai_assistant: { enabled: 'false' } });
  assert.equal(res.statusCode, 400);
  for (const description of ['x'.repeat(501), ' bad\u0000description ', 42]) {
    res = await patch({ member_ai_assistant: { description } });
    assert.equal(res.statusCode, 400);
    assert.equal(state.updated, null);
  }
  state.user = null; // Member or guest with no tenant-admin session.
  res = await patch({ member_ai_assistant: { enabled: true } });
  assert.equal(res.statusCode, 401);
  assert.equal(state.updated, null);
  state.user = { tenant_id: 'tenant-a' };
  state.failRead = true;
  res = await patch({ member_ai_assistant: { enabled: true } });
  assert.equal(res.statusCode, 503);
  assert.equal(state.updated, null);
});

test('config requires authenticated tenant context and refuses setting-read failures', async () => {
  const source = readFileSync(new URL('../member-ai/config.js', import.meta.url), 'utf8')
    .replace(/^import .*;$/gm, '')
    .replace('export default async function handler', 'async function handler');
  const make = (ctx, db, read) => new Function('supabase', 'getTenantContext',
    'loadTenantAiAssistantConfig', `${source}\nreturn handler;`)(
      db, async () => ctx, read);
  const db = database({});
  for (const [ctx, status] of [[null, 401], [{ isAuthenticated: true }, 400]]) {
    const res = response();
    await make(ctx, db, async () => { throw Error('should not read'); })({ method: 'GET' }, res);
    assert.equal(res.statusCode, status);
  }
  const res = response();
  await make({ isAuthenticated: true, tenantId: 'tenant-a' }, db,
    id => loadTenantAiAssistantConfig(id, db))({ method: 'GET' }, res);
  assert.equal(res.body.tenantId, 'tenant-a');
  assert.equal(res.body.enabled, true);
  const failed = response();
  await make({ isAuthenticated: true, tenantId: 'tenant-a' }, db, async () => {
    throw new Error('read failure');
  })({ method: 'GET' }, failed);
  assert.equal(failed.statusCode, 503);
});

test('ask and all history routes enforce tenant setting before their existing work', () => {
  const ask = readFileSync(new URL('../member-ai/ask.js', import.meta.url), 'utf8');
  const history = readFileSync(new URL('./memberAiHistory.js', import.meta.url), 'utf8');
  assert.match(ask, /await requireTenantAiAssistant\(ctx\.tenantId, res\)/);
  assert.match(history, /await requireTenantAiAssistant\(ctx\.tenantId, res\)/);
  assert.match(history, /export async function resolveMemberScope/);
  for (const path of ['../member-ai/conversations.js', '../member-ai/conversations/[id].js']) {
    assert.match(readFileSync(new URL(path, import.meta.url), 'utf8'), /resolveMemberScope\(req, res\)/);
  }
});

test('ask and conversation scope stop at disabled tenant for members and admin preview', async () => {
  const askSource = readFileSync(new URL('../member-ai/ask.js', import.meta.url), 'utf8')
    .replace(/^import [\s\S]*? from .*?;\s*$/gm, '')
    .replace(/^export \{.*?;\s*$/gm, '')
    .replace('export default async function handler', 'async function handler');
  const deny = async (_tenant, res) => {
    res.status(403).json({ code: 'assistant_disabled' });
    return false;
  };
  const noMember = async () => { throw new Error('Member lookup after disabled gate'); };
  const ask = new Function('supabase', 'getTenantContext', 'requireTenantAiAssistant',
    'getSessionMember', `${askSource}\nreturn handler;`)(
      {}, async () => ({ isAuthenticated: true, tenantId: 'tenant-a' }), deny, noMember);
  const askRes = response();
  await ask({ method: 'POST', headers: {}, body: { question: 'What is new?' } }, askRes);
  assert.equal(askRes.statusCode, 403);
  assert.equal(askRes.body.code, 'assistant_disabled');

  const historySource = readFileSync(new URL('./memberAiHistory.js', import.meta.url), 'utf8')
    .replace(/^import [\s\S]*? from .*?;\s*$/gm, '')
    .replace(/^export /gm, '');
  const scope = new Function('getTenantContext', 'getSessionMember', 'requireTenantAiAssistant',
    `${historySource}\nreturn resolveMemberScope;`)(
      async () => ({ isAuthenticated: true, tenantId: 'tenant-a' }), noMember, deny);
  const historyRes = response();
  assert.equal(await scope({}, historyRes), null);
  assert.equal(historyRes.statusCode, 403);
});

test('enabled assistant still respects excluded-member RBAC in ask and history', async () => {
  const askSource = readFileSync(new URL('../member-ai/ask.js', import.meta.url), 'utf8')
    .replace(/^import [\s\S]*? from .*?;\s*$/gm, '')
    .replace(/^export \{.*?;\s*$/gm, '')
    .replace('export default async function handler', 'async function handler');
  const ctx = async () => ({ isAuthenticated: true, tenantId: 'tenant-a' });
  const member = async () => ({ id: 'member-a', role_id: 'role-a', member_excluded_features: [] });
  const excludes = async () => ['support.member-ai'];
  const checker = () => ({ canAccessFeature: () => false });
  const enabled = async () => true;
  const db = {
    from(table) {
      assert.equal(table, 'member_group_assignment');
      const query = {
        select() { return query; },
        eq() { return query; },
        then(resolve, reject) { return Promise.resolve({ data: [], error: null }).then(resolve, reject); },
      };
      return query;
    },
  };
  const ask = new Function('supabase', 'getTenantContext', 'requireTenantAiAssistant',
    'getSessionMember', 'resolveMemberExclusions', 'makeFeatureAccessChecker',
    `${askSource}\nreturn handler;`)(
      db, ctx, enabled, member, excludes, checker);
  const askRes = response();
  await ask({ method: 'POST', headers: {}, body: { question: 'What is new?' } }, askRes);
  assert.equal(askRes.statusCode, 403);
  assert.equal(askRes.body.code, 'feature_excluded');

  const historySource = readFileSync(new URL('./memberAiHistory.js', import.meta.url), 'utf8')
    .replace(/^import [\s\S]*? from .*?;\s*$/gm, '')
    .replace(/^export /gm, '');
  const scope = new Function('getTenantContext', 'getSessionMember', 'requireTenantAiAssistant',
    'resolveMemberExclusions', 'makeFeatureAccessChecker', 'supabase',
    `${historySource}\nreturn resolveMemberScope;`)(
      ctx, member, enabled, excludes, checker, {});
  const historyRes = response();
  assert.equal(await scope({}, historyRes), null);
  assert.equal(historyRes.statusCode, 403);
  assert.equal(historyRes.body.code, 'feature_excluded');
});

test('disabling blocks existing history; re-enabling exposes unchanged owned conversations', async () => {
  const stored = {
    conversation: { id: 'conversation-a', title: 'Earlier question' },
    messages: [{ id: 'message-a', role: 'user', content: 'Earlier question', position: 0 }],
  };
  const settings = { member_ai_assistant: { enabled: false } };
  const reads = [];
  const db = {
    from(table) {
      reads.push(table);
      if (table === 'tenant') {
        return { select() { return this; }, eq(key, value) {
          assert.deepEqual([key, value], ['id', 'tenant-a']); return this;
        }, async single() { return { data: { settings }, error: null }; } };
      }
      const query = {
        select() { return query; },
        eq(key, value) {
          if (key === 'tenant_id') assert.equal(value, 'tenant-a');
          if (key === 'member_id') assert.equal(value, 'member-a');
          return query;
        },
        order() { return query; },
        limit() { return query; },
        async maybeSingle() { return { data: stored.conversation, error: null }; },
        then(resolve, reject) {
          return Promise.resolve({
            data: table === 'member_ai_conversation' ? [stored.conversation] : stored.messages,
            error: null,
          }).then(resolve, reject);
        },
      };
      return query;
    },
  };
  const historySource = readFileSync(new URL('./memberAiHistory.js', import.meta.url), 'utf8')
    .replace(/^import [\s\S]*? from .*?;\s*$/gm, '')
    .replace(/^export /gm, '');
  const scope = new Function('getTenantContext', 'getSessionMember', 'requireTenantAiAssistant',
    'resolveMemberExclusions', 'makeFeatureAccessChecker', 'supabase',
    `${historySource}\nreturn resolveMemberScope;`)(
      async () => ({ isAuthenticated: true, tenantId: 'tenant-a' }),
      async () => ({ id: 'member-a' }),
      (tenantId, res) => requireTenantAiAssistant(tenantId, res, db),
      async () => [], () => ({ canAccessFeature: () => true }), db);
  const route = path => {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8')
      .replace(/^import [\s\S]*? from .*?;\s*$/gm, '')
      .replace('export default async function handler', 'async function handler');
    return new Function('supabase', 'resolveMemberScope', 'MAX_MESSAGES',
      `${source}\nreturn handler;`)(db, scope, 400);
  };
  const list = route('../member-ai/conversations.js');
  const detail = route('../member-ai/conversations/[id].js');
  const req = { method: 'GET', query: { id: 'conversation-a' } };
  for (const handler of [list, detail]) {
    const res = response();
    await handler(req, res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, 'assistant_disabled');
  }
  assert.deepEqual(reads, ['tenant', 'tenant']);
  settings.member_ai_assistant.enabled = true;
  const listRes = response();
  await list(req, listRes);
  assert.equal(listRes.statusCode, 200);
  assert.deepEqual(listRes.body.conversations, [stored.conversation]);
  const detailRes = response();
  await detail(req, detailRes);
  assert.equal(detailRes.statusCode, 200);
  assert.deepEqual(detailRes.body.messages, stored.messages);
});