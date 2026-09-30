import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveMemberAiRetrievalContext, memberAiRetrievalArguments, MEMBER_AI_RPC_ARGUMENTS } from './memberAiRetrieval.js';
import { isChunkVisibleToMember } from './memberContentVisibility.js';
import * as ranking from './memberAiRanking.js';

function database(tables, reads = []) {
  return { from(table) {
    const filters = [];
    let start = 0, end = Infinity;
    const q = {
      select() { return q; },
      eq(key, value) { filters.push(row => row[key] === value); return q; },
      in(key, values) { filters.push(row => values.includes(row[key])); return q; },
      ilike(key, value) { filters.push(row => row[key]?.toLowerCase() === value.toLowerCase()); return q; },
      order() { return q; },
      range(a, b) { start = a; end = b; return q; },
      then(resolve, reject) {
        reads.push(table);
        return Promise.resolve({ data: (tables[table] || []).filter(row => filters.every(f => f(row))).slice(start, end + 1) }).then(resolve, reject);
      },
    };
    return q;
  } };
}
const viewer = { tenantId: 'tenant-a', memberId: 'member-a', roleId: 'role-a',
  groupIds: new Set(['group-a']), isAdmin: false, canAccessFeature: key => key !== 'content.news' };

test('14-argument contract retains all established types and server-derived permission lists', async () => {
  const context = await resolveMemberAiRetrievalContext({ db: database({
    resource_category: [{ tenant_id: 'tenant-a', excluded_role_ids: ['role-a'], subcategories: ['secret'] }],
  }), ...viewer });
  const args = memberAiRetrievalArguments(context, Array(1536).fill(0), 'Question', 40);
  assert.deepEqual(Object.keys(args).sort(), [...MEMBER_AI_RPC_ARGUMENTS].sort());
  assert.deepEqual(args.p_group_ids, ['group-a']);
  assert.deepEqual(args.p_hidden_subcategories, ['secret']);
  assert.equal(args.p_is_admin, false);
  assert.equal(args.p_allowed_feature_keys.includes('content.news'), false);
  assert.deepEqual(args.p_allowed_content_types, ['resource', 'event', 'complex_event', 'news_post', 'blog_post', 'canvas_page']);
  assert.deepEqual(args.p_eligible_pdf_chunk_ids, []);
  assert.equal(args.p_query_text, 'Question');
  assert.throws(() => memberAiRetrievalArguments(context, [0], 'Question'), /embedding/);
});

test('event and session authorization uses confirmed current-tenant bookings and ticket tracks', async () => {
  const ctx = await resolveMemberAiRetrievalContext({ ...viewer, db: database({
    member: [{ id: 'member-a', tenant_id: 'tenant-a', email: 'member@example.invalid' }],
    resource: [{ id: 'r', tenant_id: 'tenant-a', status: 'active', linked_events: [
      { event_id: 'event-a' }, { event_id: 'event-b' }, { event_id: 'event-a', session_id: 'session-a' },
      { event_id: 'event-a', session_id: 'session-b' },
    ] }],
    booking: [{ tenant_id: 'tenant-b', member_id: 'member-a', status: 'confirmed', event_id: 'event-b' }],
    complex_event_booking: [{ tenant_id: 'tenant-a', member_id: 'member-a', status: 'confirmed', event_id: 'event-a', ticket_class_id: 'ticket-a' }],
    complex_event_session: ['a', 'b'].map(id => ({ tenant_id: 'tenant-a', id: `session-${id}`, complex_event_id: 'event-a' })),
    complex_event_session_track: ['a', 'b'].map(id => ({ tenant_id: 'tenant-a', complex_event_session_id: `session-${id}`, complex_event_track_id: `track-${id}` })),
    complex_event_ticket_class: [{ tenant_id: 'tenant-a', id: 'ticket-a', complex_event_id: 'event-a', linked_track_ids: ['track-a'], all_tracks: false }],
  }) });
  assert.deepEqual(ctx.p_accessible_event_ids, ['event-a']);
  assert.deepEqual(ctx.p_accessible_session_ids, ['session-a']);
});

test('permission read failures and missing validated identity refuse retrieval', async () => {
  await assert.rejects(resolveMemberAiRetrievalContext({ ...viewer, memberId: null, db: database({}) }), /Validated/);
  const db = { from() { const q = { select() { return q; }, eq() { return q; }, order() { return Promise.resolve({ error: new Error('permission lookup failed') }); } }; return q; } };
  await assert.rejects(resolveMemberAiRetrievalContext({ ...viewer, db }), /permission lookup failed/);
});

// Execute the actual endpoint, replacing only its infrastructure dependencies.
// No network, provider credentials or production mutations are permitted.
function handler(dependencies) {
  const source = readFileSync(new URL('../member-ai/ask.js', import.meta.url), 'utf8')
    .replace(/^import [\s\S]*? from .*?;\s*$/gm, '')
    .replace(/^export \{.*?;\s*$/gm, '')
    .replace('export default async function handler', 'async function handler');
  return new Function(...Object.keys(dependencies), `${source}\nreturn handler;`)(...Object.values(dependencies));
}
const response = () => ({ statusCode: 200, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });

test('actual ask sends complete context; inaccessible RPC candidates never reach synthesis', async () => {
  const db = database({});
  let calls = 0;
  let synthesis = '';
  db.rpc = async (name, args) => {
    calls++;
    assert.equal(name, 'match_member_content_chunks');
    assert.deepEqual(Object.keys(args).sort(), [...MEMBER_AI_RPC_ARGUMENTS].sort());
    assert.equal(args.p_tenant_id, 'tenant-a');
    assert.equal(args.p_is_admin, false);
    assert.deepEqual(args.p_eligible_pdf_chunk_ids, []);
    assert.equal(args.p_allowed_feature_keys.includes('content.news'), false);
    return { data: [
      { id: 'chunk-a', tenant_id: 'tenant-a', content_type: 'blog_post', source_id: 'a', status: 'published', title: 'Allowed', content: 'PUBLIC_EXCERPT', link: '/article/a', feature_key: 'content.articles', similarity: 0.8 },
      { id: 'chunk-b', tenant_id: 'tenant-b', content_type: 'blog_post', source_id: 'b', status: 'published', title: 'Foreign', content: 'FOREIGN_SECRET', similarity: 0.9 },
      { id: 'chunk-c', tenant_id: 'tenant-a', content_type: 'news_post', source_id: 'c', status: 'published', title: 'Excluded', content: 'RBAC_SECRET', feature_key: 'content.news', similarity: 0.9 },
    ] };
  };
  class FakeOpenAI {
    embeddings = { create: async () => ({ data: [{ embedding: Array(1536).fill(0) }] }) };
    chat = { completions: { create: async request => {
      synthesis = JSON.stringify(request.messages);
      return { choices: [{ message: { content: 'PUBLIC_EXCERPT [1]' } }] };
    } } };
  }
  const old = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'isolated-test-not-a-real-key';
  try {
    const ask = handler({
      ...ranking, OpenAI: FakeOpenAI, supabase: db,
      getTenantContext: async () => ({ isAuthenticated: true, tenantId: 'tenant-a', memberId: 'member-a' }),
      getSessionMember: async () => ({ id: 'member-a', tenant_id: 'tenant-a', role_id: 'role-a' }),
      requireTenantAiAssistant: async () => true,
      resolveMemberExclusions: async () => ['content.news'],
      makeFeatureAccessChecker: () => ({ canAccessFeature: viewer.canAccessFeature }),
      looksLikeStructuredQuestion: () => false,
      resolveMemberAiRetrievalContext, memberAiRetrievalArguments, isChunkVisibleToMember,
    });
    const res = response();
    await ask({ method: 'POST', headers: {}, body: { question: 'Hiring advice', p_is_admin: true, p_tenant_id: 'tenant-b' } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(calls, 1);
    assert.equal(res.body.grounded, true);
    assert.equal(res.body.sources.length, 1);
    assert.ok(synthesis.includes('PUBLIC_EXCERPT'));
    assert.ok(!synthesis.includes('FOREIGN_SECRET'));
    assert.ok(!synthesis.includes('RBAC_SECRET'));
  } finally {
    if (old === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = old;
  }
});

test('actual ask does not promote failed member lookup or tenant mismatch into admin', async () => {
  for (const context of [
    { isAuthenticated: true, tenantId: 'tenant-a', memberId: 'member-a' },
    { isAuthenticated: true, tenantId: 'tenant-a', tenantMismatch: true, tenantUserId: 'admin' },
  ]) {
    const ask = handler({ ...ranking, supabase: {}, getTenantContext: async () => context,
      getSessionMember: async () => null, requireTenantAiAssistant: async () => true });
    const res = response();
    await ask({ method: 'POST', headers: {}, body: { question: 'Hiring advice' } }, res);
    assert.ok([401, 403].includes(res.statusCode));
  }
});