import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveMemberAiRetrievalContext, memberAiRetrievalArguments, MEMBER_AI_RPC_ARGUMENTS } from './memberAiRetrieval.js';
import { isChunkVisibleToMember } from './memberContentVisibility.js';
import * as ranking from './memberAiRanking.js';
import * as contentAccess from './memberContentAccess.js';
import * as answerHelpers from './memberAiAnswer.js';
import { fetchCategoriesWithAccess, computeHiddenSubcategories } from './resourceCategoryAccess.js';

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
      limit(n) { end = start + n - 1; return q; },
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
    .replace(/^export async function /gm, 'async function ')
    .replace(/^export function /gm, 'function ')
    .replace('export default async function handler', 'async function handler');
  const injected = {
    ...contentAccess, ...answerHelpers,
    fetchCategoriesWithAccess, computeHiddenSubcategories,
    getSessionTenantUser: async () => null,
    ...dependencies,
  };
  return new Function(...Object.keys(injected), `${source}\nreturn handler;`)(...Object.values(injected));
}
const response = () => ({ statusCode: 200, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });

test('actual ask sends complete context; inaccessible RPC candidates never reach synthesis', async () => {
  const db = database({
    blog_post: [{ id: 'a', tenant_id: 'tenant-a', status: 'published', title: 'Allowed', slug: 'a' }],
    member_content_source: [{
      source_id: 'a', content_type: 'blog_post', tenant_id: 'tenant-a', active_generation: 1,
    }],
  });
  let calls = 0;
  let synthesis = '';
  db.rpc = async (name, args) => {
    calls++;
    assert.equal(name, 'match_member_content_chunks');
    assert.deepEqual(Object.keys(args).sort(), [...MEMBER_AI_RPC_ARGUMENTS].sort());
    assert.equal(args.p_tenant_id, 'tenant-a');
    assert.equal(args.p_is_admin, false);
    assert.equal(args.p_is_authenticated, true);
    assert.equal(args.p_role_id, 'role-a');
    assert.deepEqual(args.p_group_ids, []);
    assert.deepEqual(args.p_accessible_event_ids, []);
    assert.deepEqual(args.p_accessible_session_ids, []);
    assert.deepEqual(args.p_eligible_pdf_chunk_ids, []);
    assert.equal(args.p_allowed_feature_keys.includes('content.news'), false);
    return { data: [
      { id: 'chunk-a', tenant_id: 'tenant-a', content_type: 'blog_post', source_id: 'a', source_generation: 1, status: 'published', title: 'Allowed', content: 'PUBLIC_EXCERPT', link: '/article/a', feature_key: 'content.articles', similarity: 0.8 },
      { id: 'chunk-b', tenant_id: 'tenant-b', content_type: 'blog_post', source_id: 'b', status: 'published', title: 'Foreign', content: 'FOREIGN_SECRET', similarity: 0.9 },
      { id: 'chunk-c', tenant_id: 'tenant-a', content_type: 'news_post', source_id: 'c', status: 'published', title: 'Excluded', content: 'RBAC_SECRET', feature_key: 'content.news', similarity: 0.9 },
    ] };
  };
  class FakeOpenAI {
    embeddings = { create: async () => ({ data: [{ embedding: Array(1536).fill(0) }] }) };
    chat = { completions: { create: async request => {
      synthesis = JSON.stringify(request.messages);
      return { choices: [{ message: { content: 'PUBLIC_EXCERPT [S1]' } }] };
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
      reserveMemberAiUsage: async () => ({ allowed: true, reservationId: 'fixture-reservation' }),
      finishMemberAiUsage: async () => {},
      getMemberAiSettings: async () => ({ allowed_content_types: [
        'resource', 'event', 'complex_event', 'news_post', 'blog_post', 'canvas_page',
      ] }),
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

test('microsite disable denies stale indexed Canvas candidates, synthesis, citations and history', async () => {
  const site = { id: 'site-a', tenant_id: 'tenant-a', is_active: true, path_prefix: 'partners' };
  const page = { id: 'page-a', tenant_id: 'tenant-a', microsite_id: site.id,
    builder_type: 'canvas', status: 'published', layout_type: 'public', slug: 'welcome', title: 'Welcome' };
  const candidate = { id: 'chunk-page', tenant_id: 'tenant-a', content_type: 'canvas_page',
    source_id: page.id, source_generation: 8, status: 'published', layout_type: 'public',
    access_scope: 'public', content: 'SITE_ONLY_SECRET', title: page.title, similarity: 0.9 };
  const tables = { microsite: [site], i_edit_page: [page], member_content_source: [{
    source_id: page.id, content_type: 'canvas_page', tenant_id: 'tenant-a', active_generation: 8,
  }] };
  const db = database(tables);
  // Deliberately emulate a stale RPC result: the live gate must work even if
  // generation invalidation is delayed, and again after a provider response.
  db.rpc = async () => ({ data: [candidate] });
  const member = { id: 'member-a', role_id: 'role-a', tenant_id: 'tenant-a' };
  const visibilityCtx = { tenantId: 'tenant-a', isAuthenticated: true, member,
    roleId: 'role-a', canAccessFeature: () => true, groupIds: new Set() };
  const revalidate = (ctx = visibilityCtx) => contentAccess.revalidateMemberContentCandidates({
    supabase: db, candidates: [candidate], visibilityCtx: ctx, accessibleSessionIds: new Set(),
  });
  assert.equal((await revalidate()).length, 1, 'published indexed page is initially eligible');
  const historySource = readFileSync(new URL('./memberAiHistory.js', import.meta.url), 'utf8')
    .replace(/^import [\s\S]*? from .*?;\s*$/gm, '').replace(/^export /gm, '');
  const redact = new Function('supabase', 'revalidateMemberContentCandidates',
    `${historySource}\nreturn redactRevokedHistoryMessages;`)(db, contentAccess.revalidateMemberContentCandidates);
  const messages = [{ id: 'old-answer', role: 'assistant', content: 'SITE_ONLY_SECRET', sources: [{
    type: 'canvas_page', sourceId: page.id, sourceGeneration: 8,
    supportingProvenance: [{ dependencies: [] }], title: page.title, link: '/partners/welcome',
  }] }];
  const scope = { tenantId: 'tenant-a', memberId: member.id, visibilityCtx, accessibleEventIds: new Set() };
  assert.equal((await redact(messages, scope))[0].redacted, undefined);
  for (const invalid of [
    () => { site.is_active = false; },
    () => { site.is_active = true; tables.microsite = []; },
    () => { tables.microsite = [site]; site.tenant_id = 'tenant-b'; },
  ]) {
    invalid();
    for (const isAuthenticated of [false, true]) {
      assert.deepEqual(await revalidate({ ...visibilityCtx, isAuthenticated }), []);
    }
    const hidden = (await redact(messages, scope))[0];
    assert.equal(hidden.redacted, true);
    assert.deepEqual(hidden.sources, []);
    assert.doesNotMatch(hidden.content, /SITE_ONLY_SECRET/);
  }
  site.tenant_id = 'tenant-a';
  let providerCalls = 0;
  let disableDuringAnswer = false;
  class FakeOpenAI {
    embeddings = { create: async () => ({ data: [{ embedding: Array(1536).fill(0) }] }) };
    chat = { completions: { create: async () => {
      providerCalls++;
      if (disableDuringAnswer) site.is_active = false;
      return { choices: [{ message: { content: 'SITE_ONLY_SECRET [S1]' } }] };
    } } };
  }
  const oldKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'isolated-test-not-a-real-key';
  try {
    const ask = handler({ ...ranking, OpenAI: FakeOpenAI, supabase: db,
      getTenantContext: async () => ({ tenantId: 'tenant-a', isAuthenticated: true }),
      getSessionMember: async () => member, requireTenantAiAssistant: async () => true,
      resolveMemberExclusions: async () => [], makeFeatureAccessChecker: () => ({ canAccessFeature: () => true }),
      looksLikeStructuredQuestion: () => false, isChunkVisibleToMember,
      reserveMemberAiUsage: async () => ({ allowed: true, reservationId: 'fixture' }),
      finishMemberAiUsage: async () => {},
      getMemberAiSettings: async () => ({ allowed_content_types: ['canvas_page'] }),
    });
    for (const duringAnswer of [false, true]) {
      site.is_active = duringAnswer;
      disableDuringAnswer = duringAnswer;
      const res = response();
      await ask({ method: 'POST', headers: {}, body: { question: 'Welcome instructions' } }, res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.grounded, false);
      assert.deepEqual(res.body.sources, []);
      assert.doesNotMatch(res.body.answer, /SITE_ONLY_SECRET/);
      assert.equal(providerCalls, duringAnswer ? 1 : 0);
    }
  } finally {
    if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey;
  }
});