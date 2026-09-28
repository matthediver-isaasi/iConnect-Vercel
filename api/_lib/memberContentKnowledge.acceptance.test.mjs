import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reindexMemberContentItem } from './memberContentIndexer.js';
import { isChunkVisibleToMember, CONTENT_TYPES } from './memberContentVisibility.js';
import { isSourceGenerationCurrent } from './memberContentAccess.js';

function fixture(type, tenant) {
  return {
    id: `${tenant}-${type}`, tenant_id: tenant, title: `${tenant} approved guide`,
    status: type === 'resource' ? 'active' : 'published', resource_type: 'article',
    description: `${tenant} permitted description`, content: `${tenant} permitted article`,
    start_date: '2026-10-16T12:00:00Z', is_public: true,
    builder_type: 'canvas', layout_type: 'hybrid', slug: 'approved-guide',
    canvas_design: { root: { sections: [{ children: [
      { type: 'text', content: { text: `${tenant} public introduction` } },
      { type: 'custom-html', content: {
        memberOnly: true, html: `<p>${tenant} protected Canvas instruction</p>`, guestMessage: 'Sign in',
      } },
    ] }] } },
  };
}

function database(canonical) {
  const published = [];
  return {
    published,
    rpc(name, args) {
      if (name === 'claim_member_content_generation') return Promise.resolve({ data: { generation: 8, claim_token: 'claim' } });
      if (name === 'publish_member_content_knowledge') {
        if (!args.p_tenant_id) return Promise.resolve({ data: false });
        published.push(...args.p_rows);
        return Promise.resolve({ data: true });
      }
      throw new Error(`Unexpected RPC ${name}`);
    },
    from(table) {
      const filters = {};
      let single = false;
      const q = {
        select() { return q; }, limit() { return q; },
        eq(key,value) { filters[key]=value; return q; }, in() { return q; },
        maybeSingle() { single=true; return q; },
        then(resolve) {
          assert.equal(filters.tenant_id,canonical.tenant_id,'every canonical read is tenant scoped');
          const rows = table === 'member_content_chunk' ? [] : [canonical];
          resolve({ data: single ? rows[0] || null : rows, error: null });
        },
      };
      return q;
    },
  };
}
const provider = { embeddings: { create: async ({ input }) => ({
  data: input.map(()=>({embedding:[0.1,0.2]})),
}) } };

test('two-tenant six-adapter generation acceptance preserves public/protected projections and multi-source evidence', async () => {
  const corpus = [];
  for (const tenant of ['tenant-a','tenant-b']) {
    for (const type of CONTENT_TYPES) {
      const canonical = fixture(type,tenant);
      const db = database(canonical);
      // Caller text is stale/untrusted: only the canonical read after claim may
      // reach embeddings or publication.
      await reindexMemberContentItem(type,{ ...canonical, title:'DO NOT INDEX CALLER TEXT' },{
        supabase:db, openai:provider,
      });
      assert.ok(db.published.length);
      assert.ok(db.published.every(row=>!row.content.includes('DO NOT INDEX')));
      corpus.push(...db.published);
    }
  }
  const viewer = { tenantId:'tenant-a',isAuthenticated:true,roleId:'member-role',
    canAccessFeature:()=>true,groupIds:new Set() };
  const member = corpus.filter(row=>isChunkVisibleToMember(row,viewer));
  assert.deepEqual(new Set(member.map(row=>row.content_type)),new Set(CONTENT_TYPES));
  assert.ok(member.every(row=>row.tenant_id==='tenant-a'));
  assert.ok(member.some(row=>row.content.includes('protected Canvas instruction')));
  const guest = corpus.filter(row=>isChunkVisibleToMember(row,{...viewer,isAuthenticated:false,roleId:null}));
  assert.ok(guest.every(row=>!row.content.includes('protected Canvas instruction')));
  assert.ok(guest.some(row=>row.content.includes('public introduction')));
  const revoked = member.filter(row=>isSourceGenerationCurrent(row.source_generation,null));
  assert.deepEqual(revoked,[],'source revocation removes evidence from all families immediately');
});

test('member-only Canvas pages publish authenticated content instead of an empty public repair', async () => {
  const source = { ...fixture('canvas_page','tenant-a'),layout_type:'member' };
  const db = database(source);
  await reindexMemberContentItem('canvas_page',source,{supabase:db,openai:provider});
  assert.ok(db.published.length);
  assert.ok(db.published.every(row=>row.access_scope==='authenticated'));
});

test('event-linked resources are indexed with their entitlement metadata intact', async () => {
  const source = { ...fixture('resource','tenant-a'),linked_events:[{event_id:'approved-event'}] };
  const db = database(source);
  await reindexMemberContentItem('resource',source,{supabase:db,openai:provider});
  assert.deepEqual(db.published[0].linked_events,source.linked_events);
});