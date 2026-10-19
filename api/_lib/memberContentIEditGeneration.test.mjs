import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  IEDIT_PAGE_COLUMNS,
  buildIEditGenerationSnapshot,
  isCurrentIEditChunk,
  isIndexableIEditPage,
} from './memberContentIEditGeneration.js';
import { IEDIT_COMPONENT_POLICIES } from './memberContentIEditExtraction.js';
import {
  writeMemberContentGeneration,
  MEMBER_CONTENT_GENERATION_STALE,
  MEMBER_CONTENT_EMBEDDING_BUDGET,
} from './memberContentGenerationWriter.js';
import { PUBLIC_CANVAS_LAYOUT_TYPES } from './memberContentVisibility.js';
import { isChunkVisibleToMember } from './memberContentVisibility.js';
import * as contentAccess from './memberContentAccess.js';
import * as ranking from './memberAiRanking.js';
import * as answerHelpers from './memberAiAnswer.js';
import { fetchCategoriesWithAccess, computeHiddenSubcategories } from './resourceCategoryAccess.js';
import { buildResponsePolicyInstructions, noEvidenceResponse } from './tenantAiAssistant.js';
import { normalizeResponsePolicy } from '../../shared/memberAiResponsePolicy.js';

const TENANT = 'tenant-test';
const SOURCE = 'page-test';
const page = overrides => ({
  id: SOURCE, tenant_id: TENANT, title: 'Canonical page', slug: 'canonical-page',
  status: 'published', builder_type: 'iedit', layout_type: 'public', microsite_id: null,
  ...overrides,
});
const element = (id = 'element-1', overrides = {}) => ({
  id, tenant_id: TENANT, page_id: SOURCE, element_type: 'text_block',
  display_order: 0, content: { text: `Copy for ${id}` }, settings: {},
  ...overrides,
});
const scope = (overrides = {}) => ({ tenantId: TENANT, isAuthenticated: true, roleId: 'role-board', ...overrides });
const candidate = chunk => ({
  content: chunk.content, access_scope: chunk.accessScope, provenance: structuredClone(chunk.provenance),
});
const text = snapshot => snapshot.chunks.map(chunk => chunk.content).join('\n');
const emptyDynamic = async () => ({ sections: [], coverage: [], dependencies: [] });

// In-memory query/RPC simulator only. It implements count, tenant predicates,
// deterministic ordering and column projection rather than ignoring filters.
// The isolated test runner disallows any accidental network/production access.
function database({ source = page(), elements = [element()], microsites = [], tables = {}, response, onRpc } = {}) {
  const operations = [];
  const state = {
    tables: { i_edit_page: source ? [source] : [], i_edit_page_element: elements, microsite: microsites, member_content_chunk: [], ...tables },
    generation: 1, claimToken: null, claimSerial: 0, published: [], publicationAttempts: [],
  };
  const db = {
    state, operations,
    from(table) {
      const call = { table, filters: {}, inFilters: {}, orders: [], operation: 'select' };
      const query = {
        select(columns, options) { call.columns = columns; call.selectOptions = options; return query; },
        eq(key, value) { call.filters[key] = value; return query; },
        in(key, values) { call.inFilters[key] = values; return query; },
        order(key, options) { call.orders.push([key, options]); return query; },
        range(start, end) { call.range = [start, end]; return query; },
        limit(value) { call.limit = value; return query; },
        maybeSingle() { call.single = true; return query; },
        update(patch) { call.operation = 'update'; call.patch = patch; return query; },
        delete() { throw new Error('Direct deletion forbidden'); },
        upsert() { throw new Error('Direct upsert forbidden'); },
        then(resolve, reject) {
          return Promise.resolve().then(() => {
            operations.push(structuredClone(call));
            const override = response?.(call, state);
            if (override !== undefined) return override;
            if (call.operation === 'update') {
              assert.equal(table, 'member_content_source', 'only a lease CAS update is allowed');
              if (call.filters.generation === state.generation && call.filters.claim_token === state.claimToken) state.claimToken = null;
              return { data: null, error: null };
            }
            assert.ok(Object.hasOwn(state.tables, table), `Unexpected table ${table}`);
            let rows = state.tables[table].filter(row =>
              Object.entries(call.filters).every(([key, value]) => row[key] === value) &&
              Object.entries(call.inFilters).every(([key, values]) => values.includes(row[key])));
            for (const [key, options] of [...call.orders].reverse()) {
              rows = [...rows].sort((a, b) => (a[key] === b[key] ? 0 : a[key] < b[key] ? -1 : 1) * (options.ascending ? 1 : -1));
            }
            const count = rows.length;
            if (call.range) rows = rows.slice(call.range[0], call.range[1] + 1);
            if (call.limit != null) rows = rows.slice(0, call.limit);
            if (call.columns && call.columns !== '*') {
              const columns = call.columns.split(',').map(column => column.trim());
              rows = rows.map(row => Object.fromEntries(columns.filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]])));
            }
            return { data: call.single ? rows[0] || null : rows, count, error: null };
          }).then(resolve, reject);
        },
      };
      return query;
    },
    async rpc(name, args) {
      operations.push({ rpc: name, args: structuredClone(args) });
      const override = await onRpc?.(name, args, state);
      if (override !== undefined) return override;
      if (name === 'publish_member_content_knowledge' && args.p_tenant_id === null) return { data: false, error: null };
      if (name === 'claim_member_content_generation') {
        state.claimToken = `claim-${++state.claimSerial}`;
        return { data: [{ generation: state.generation, claim_token: state.claimToken }], error: null };
      }
      if (name === 'publish_member_content_knowledge') {
        state.publicationAttempts.push(structuredClone(args));
        if (args.p_generation !== state.generation || args.p_claim_token !== state.claimToken) return { data: false, error: null };
        state.published = structuredClone(args.p_rows);
        state.tables.member_content_chunk = structuredClone(args.p_rows);
        state.claimToken = null;
        return { data: true, error: null };
      }
      throw new Error(`Unexpected RPC ${name}`);
    },
  };
  return db;
}

const snapshot = (db, overrides = {}) => buildIEditGenerationSnapshot({
  supabase: db, tenantId: TENANT, sourceId: SOURCE,
  claim: { generation: 1, claim_token: 'snapshot-claim' }, ...overrides,
});
const write = (db, overrides = {}) => writeMemberContentGeneration('iedit_page', {
  id: SOURCE, tenant_id: TENANT, title: 'UNTRUSTED caller title', search_text: 'UNTRUSTED caller text',
}, {
  supabase: db, openai: {}, embedTexts: async (_client, inputs) => inputs.map(() => [0.1, 0.2]),
  buildSnapshot: options => snapshot(db, options), ...overrides,
});

test('snapshot requires a valid generation before any canonical query', async () => {
  const db = database();
  for (const claim of [undefined, {}, { generation: 0 }, { generation: -1 }, { generation: 1.2 }, { generation: 'bad' }, { generation: Number.MAX_SAFE_INTEGER + 1 }]) {
    await assert.rejects(snapshot(db, { claim }), /IEDIT_CLAIM_REQUIRED/);
  }
  assert.deepEqual(db.operations, []);
  assert.ok((await snapshot(db, { claim: { generation: '2' } })).item);
});

test('canonical page/ordered element reads use tenant, page, builder and explicit columns, never search_text', async () => {
  const db = database({
    source: page({ search_text: 'UNTRUSTED cached text', canvas_design: { text: 'UNTRUSTED canvas text' } }),
    elements: [
      element('later', { display_order: 9, content: { heading: 'Later', text: 'Later body' } }),
      element('b', { display_order: 1 }),
      element('a', { display_order: 1 }),
      element('foreign-tenant', { tenant_id: 'another-tenant', content: { text: 'UNTRUSTED other tenant' } }),
      element('foreign-page', { page_id: 'another-page', content: { text: 'UNTRUSTED other page' } }),
    ],
  });
  const result = await snapshot(db);
  assert.deepEqual(db.operations[0].filters, { tenant_id: TENANT, id: SOURCE, builder_type: 'iedit' });
  assert.equal(db.operations[0].columns, IEDIT_PAGE_COLUMNS);
  assert.doesNotMatch(db.operations[0].columns, /search_text|canvas_design|\*/);
  const reads = db.operations.filter(call => call.table === 'i_edit_page_element');
  assert.equal(reads.length, 1);
  assert.deepEqual(reads[0].filters, { tenant_id: TENANT, page_id: SOURCE });
  assert.deepEqual(reads[0].orders, [['display_order', { ascending: true }], ['id', { ascending: true }]]);
  assert.equal(reads[0].selectOptions.count, 'exact');
  assert.deepEqual(reads[0].range, [0, 99]);
  assert.deepEqual(result.coverage.map(row => row.elementId), ['a', 'b', 'later']);
  assert.doesNotMatch(text(result), /UNTRUSTED/);
  assert.equal(result.metadata.content_type, 'iedit_page');
  assert.equal(result.metadata.link, '/canonical-page');
  assert.deepEqual(result.dependencies, []);
});

test('page allowlist admits only published iEdit public/hybrid/member layouts', async () => {
  for (const layout_type of [...PUBLIC_CANVAS_LAYOUT_TYPES, 'member']) assert.equal(isIndexableIEditPage(page({ layout_type })), true);
  for (const patch of [{ status: 'draft' }, { builder_type: 'canvas' }, { builder_type: 'legacy' }, { layout_type: 'unknown' }]) {
    assert.equal(isIndexableIEditPage(page(patch)), false);
    const db = database({ source: page(patch) });
    assert.deepEqual((await snapshot(db)).chunks, []);
    assert.equal(db.operations.length, 1);
  }
  const missing = database({ source: null });
  assert.equal((await snapshot(missing)).item, null);
});

test('member-only pages never read elements for guests and mark all admitted chunks authenticated', async () => {
  const db = database({ source: page({ layout_type: 'member' }) });
  const denied = await snapshot(db, { visibilityCtx: scope({ isAuthenticated: false }) });
  assert.deepEqual(denied.chunks, []);
  assert.equal(db.operations.length, 1);
  const admitted = await snapshot(db, { visibilityCtx: scope() });
  assert.ok(admitted.chunks.length);
  assert.ok(admitted.chunks.every(chunk => chunk.accessScope === 'authenticated'));
  assert.equal(admitted.metadata.access_scope, 'authenticated');
});

test('count-checked pagination reads 101 and exactly 500 elements without an unnecessary tail query', async () => {
  for (const count of [101, 500]) {
    const db = database({ elements: Array.from({ length: count }, (_, index) => element(String(index).padStart(3, '0'), { display_order: index })) });
    const result = await snapshot(db);
    assert.equal(result.coverage.length, count);
    const reads = db.operations.filter(call => call.table === 'i_edit_page_element');
    assert.equal(reads.length, Math.ceil(count / 100));
    assert.deepEqual(reads.at(-1).range, [(reads.length - 1) * 100, reads.length * 100 - 1]);
  }
});

test('empty canonical element set is valid, but over-limit, missing counts and malformed data fail closed', async () => {
  const empty = await snapshot(database({ elements: [] }));
  assert.equal(empty.item.id, SOURCE);
  assert.deepEqual(empty.coverage, []);
  for (const bad of [
    { data: [], count: 501 }, { data: [], count: null }, { data: [], count: 1.5 },
    { data: null, count: 0 }, { data: [], count: -1 },
  ]) {
    const db = database({ response: call => call.table === 'i_edit_page_element' ? bad : undefined });
    await assert.rejects(snapshot(db), /IEDIT_ELEMENTS_INCOMPLETE/);
  }
});

test('element pagination rejects short server-cap pages, count drift, excess rows and duplicate IDs', async () => {
  const hundred = Array.from({ length: 100 }, (_, index) => element(`e-${index}`));
  const cases = [
    () => ({ data: hundred.slice(0, 3), count: 101 }),
    call => call.range[0] === 0 ? { data: hundred, count: 101 } : { data: [element('last')], count: 102 },
    () => ({ data: hundred.slice(0, 2), count: 1 }),
    call => call.range[0] === 0 ? { data: hundred, count: 101 } : { data: [hundred[0]], count: 101 },
  ];
  for (const answer of cases) {
    const db = database({ response: call => call.table === 'i_edit_page_element' ? answer(call) : undefined });
    await assert.rejects(snapshot(db), /IEDIT_ELEMENTS_(INCOMPLETE|UNSTABLE)/);
    assert.ok(db.operations.length <= 3, 'bounded failure must not loop');
  }
});

test('canonical page, microsite and element query errors propagate rather than publishing partial copy', async () => {
  for (const table of ['i_edit_page', 'microsite', 'i_edit_page_element']) {
    const error = new Error(`Controlled ${table} read failure`);
    const db = database({
      source: page({ microsite_id: 'site-1' }),
      microsites: [{ id: 'site-1', tenant_id: TENANT, is_active: true, path_prefix: 'members' }],
      response: call => call.table === table ? { data: null, error } : undefined,
    });
    await assert.rejects(snapshot(db), failure => failure === error);
  }
});

test('microsites require a current active tenant-scoped prefix and links encode both segments', async () => {
  const site = { id: 'site-1', tenant_id: TENANT, is_active: true, path_prefix: 'Special members' };
  const db = database({ source: page({ microsite_id: site.id, slug: 'Board / team' }), microsites: [site] });
  const result = await snapshot(db);
  assert.equal(result.metadata.link, '/Special%20members/Board%20%2F%20team');
  assert.equal(result.metadata.microsite_id, site.id);
  assert.equal(result.item._micrositePrefix, site.path_prefix);
  assert.deepEqual(db.operations[1].filters, { tenant_id: TENANT, id: site.id, is_active: true });
  for (const microsites of [[], [{ ...site, is_active: false }], [{ ...site, tenant_id: 'other' }], [{ ...site, path_prefix: '' }]]) {
    const denied = database({ source: page({ microsite_id: site.id }), microsites });
    assert.equal((await snapshot(denied)).item, null);
    assert.ok(!denied.operations.some(call => call.table === 'i_edit_page_element'));
  }
});

test('every registered type is processed through its explicit extraction policy and dynamic dispatch', async () => {
  const types = Object.keys(IEDIT_COMPONENT_POLICIES);
  const db = database({ elements: types.map((type, index) => element(`element-${type}`, { element_type: type, display_order: index, content: {} })) });
  const resolved = [];
  const result = await snapshot(db, {
    resolveDynamic: async options => {
      assert.equal(options.supabase, db);
      assert.equal(options.tenantId, TENANT);
      resolved.push(options.element.element_type);
      return { sections: [{ text: `Resolved ${options.element.element_type}` }], coverage: [], dependencies: [] };
    },
  });
  assert.deepEqual(resolved.sort(), types.filter(type => IEDIT_COMPONENT_POLICIES[type].dynamic).sort());
  assert.deepEqual(result.coverage.map(row => row.elementType), types);
  assert.ok(result.chunks.every(chunk => chunk.provenance.iedit.coverage === result.coverage));
  assert.ok(result.chunks.every(chunk => !chunk.content.includes('extraction_policy_applied')));
});

test('authored/dynamic chunks preserve selected board/team context and source identity without cross-contamination', async () => {
  const db = database({ elements: [
    element('board', { element_type: 'wall_of_fame', display_order: 0, content: { section_id: 'board-section', heading_text: 'Our board' } }),
    element('team', { element_type: 'wall_of_fame', display_order: 1, content: { section_id: 'team-section', heading_text: 'Our team' } }),
  ] });
  const result = await snapshot(db, {
    resolveDynamic: async ({ element: selected }) => ({
      sections: [{
        text: selected.content.section_id === 'board-section' ? 'Board editorial biography' : 'Team editorial biography',
        provenance: { dependencies: [{ table: 'wall_of_fame_section', id: selected.content.section_id, tenantId: TENANT, access: { private: 'not retained' } }] },
      }],
      coverage: [{ code: 'interactive_content', elementId: selected.id }], dependencies: [],
    }),
  });
  for (const [id, label, other] of [['board', 'Our board', 'Team editorial'], ['team', 'Our team', 'Board editorial']]) {
    const selected = result.chunks.filter(chunk => chunk.provenance.iedit.elementId === id);
    assert.equal(selected.length, 2);
    assert.ok(selected.every(chunk => chunk.content.includes('Canonical page') && chunk.content.includes(label)));
    assert.ok(selected.every(chunk => !chunk.content.includes(other)));
    assert.deepEqual(selected[1].provenance.iedit.displayDependencies, [{ table: 'wall_of_fame_section', id: `${id}-section`, tenantId: TENANT }]);
  }
  assert.notEqual(result.chunks[1].provenance.iedit.sectionKey, result.chunks[3].provenance.iedit.sectionKey);
});

test('long sections split into contiguous <=1500-character chunks without mixing elements or dropping text', async () => {
  for (const body of ['x'.repeat(3601), `${'word '.repeat(450)}\n${'other '.repeat(300)}`]) {
    const db = database({ elements: [element('long', { content: { text: body } }), element('short', { display_order: 1, content: { text: 'Other section' } })] });
    const result = await snapshot(db);
    assert.deepEqual(result.chunks.map(chunk => chunk.chunkIndex), result.chunks.map((_, index) => index));
    const long = result.chunks.filter(chunk => chunk.provenance.iedit.elementId === 'long');
    assert.ok(long.length >= 3);
    assert.ok(long.every(chunk => chunk.content.length > 0 && chunk.content.length <= 1500));
    assert.equal(new Set(long.map(chunk => chunk.provenance.iedit.sectionKey)).size, 1);
    assert.ok(long.every(chunk => /^[a-f0-9]{64}$/.test(chunk.provenance.iedit.contentHash)));
    assert.ok(long.every(chunk => chunk.content.startsWith('Canonical page\n\n')), 'continuations retain page context');
    assert.equal(long.map(chunk => chunk.content.slice('Canonical page\n\n'.length)).join('').replace(/\s/g, ''), body.replace(/\s/g, ''));
    assert.ok(long.every(chunk => !chunk.content.includes('Other section')));
  }
});

test('dynamic continuation chunks repeat selected authored header context without blending another element', async () => {
  const db = database({ elements: [
    element('board', { element_type: 'wall_of_fame', content: { heading_text: 'Our board', section_id: 'board' } }),
    element('team', { element_type: 'wall_of_fame', display_order: 1, content: { heading_text: 'Our team', section_id: 'team' } }),
  ] });
  const result = await snapshot(db, {
    resolveDynamic: async ({ element: selected }) => ({
      sections: [{ text: (selected.id === 'board' ? 'Board-only biography. ' : 'Team-only biography. ').repeat(180) }],
      coverage: [], dependencies: [],
    }),
  });
  for (const [id, own, other] of [['board', 'Our board', 'Our team'], ['team', 'Our team', 'Our board']]) {
    const continuation = result.chunks.filter(chunk => chunk.provenance.iedit.elementId === id && chunk.content.includes('biography'));
    assert.ok(continuation.length >= 3);
    assert.ok(continuation.every(chunk => chunk.content.startsWith(`Canonical page\n${own}\n\n`)));
    assert.ok(continuation.every(chunk => !chunk.content.includes(other)));
    assert.ok(continuation.every(chunk => chunk.content.length <= 1500));
  }
});

test('real dynamic resolver keeps selected Wall of Fame board and team rows in their own element chunks', async () => {
  const owned = rows => rows.map(row => ({ tenant_id: TENANT, is_active: true, ...row }));
  const db = database({
    elements: [
      element('board', { element_type: 'wall_of_fame', content: { section_id: 'board-section', heading_text: 'Our board' } }),
      element('team', { element_type: 'wall_of_fame', display_order: 1, content: { section_id: 'team-section', heading_text: 'Our team' } }),
    ],
    tables: {
      wall_of_fame_section: owned([{ id: 'board-section', name: 'Board' }, { id: 'team-section', name: 'Team' }, { id: 'unselected', name: 'UNSELECTED' }]),
      wall_of_fame_category: owned([{ id: 'board-cat', section_id: 'board-section', name: 'Directors' }, { id: 'team-cat', section_id: 'team-section', name: 'Staff' }, { id: 'other-cat', section_id: 'unselected', name: 'UNSELECTED' }]),
      wall_of_fame_person: owned([
        { id: 'board-person', category_id: 'board-cat', first_name: 'Editorial', last_name: 'Director', biography: 'Board-only biography', email: 'PRIVATE', linkedin_url: 'PRIVATE' },
        { id: 'team-person', category_id: 'team-cat', first_name: 'Editorial', last_name: 'Colleague', biography: 'Team-only biography', email: 'PRIVATE' },
        { id: 'other-person', category_id: 'other-cat', first_name: 'UNSELECTED' },
        { id: 'cross-tenant', tenant_id: 'other', category_id: 'board-cat', first_name: 'FOREIGN' },
      ]),
    },
  });
  const result = await snapshot(db);
  const board = result.chunks.filter(chunk => chunk.provenance.iedit.elementId === 'board').map(chunk => chunk.content).join('\n');
  const team = result.chunks.filter(chunk => chunk.provenance.iedit.elementId === 'team').map(chunk => chunk.content).join('\n');
  assert.match(board, /Board-only biography/);
  assert.doesNotMatch(board, /Team-only biography/);
  assert.match(team, /Team-only biography/);
  assert.doesNotMatch(team, /Board-only biography/);
  assert.doesNotMatch(text(result), /UNSELECTED|FOREIGN|PRIVATE/);
  for (const call of db.operations.filter(call => call.table?.startsWith('wall_of_fame'))) {
    assert.equal(call.filters.tenant_id, TENANT);
    assert.equal(call.selectOptions.count, 'exact');
    assert.deepEqual(call.orders.at(-1), ['id', { ascending: true }]);
    assert.doesNotMatch(call.columns, /email|linkedin_url/);
  }
});

test('role-protected injected dynamic resolver is re-evaluated for each viewer, never merged into public copy', async () => {
  const db = database({ elements: [element('protected', { element_type: 'resources_showcase', content: { headerText: 'Resource header' } })] });
  const views = [];
  const resolveDynamic = async ({ visibilityCtx }) => {
    views.push(visibilityCtx);
    return {
      sections: [
        { text: 'Public selected resource', accessScope: 'public' },
        ...(!visibilityCtx || visibilityCtx.roleId === 'role-board' ? [{ text: 'Board role restricted resource', accessScope: 'authenticated' }] : []),
      ],
      coverage: [], dependencies: [],
    };
  };
  const indexed = await snapshot(db, { resolveDynamic });
  const protectedChunk = indexed.chunks.find(chunk => chunk.content.includes('Board role restricted'));
  assert.ok(protectedChunk);
  assert.equal(protectedChunk.accessScope, 'authenticated');
  const board = await snapshot(db, { resolveDynamic, visibilityCtx: scope() });
  const team = await snapshot(db, { resolveDynamic, visibilityCtx: scope({ roleId: 'role-team' }) });
  const guest = await snapshot(db, { resolveDynamic, visibilityCtx: scope({ roleId: null, isAuthenticated: false }) });
  assert.equal(isCurrentIEditChunk(candidate(protectedChunk), board), true);
  assert.equal(isCurrentIEditChunk(candidate(protectedChunk), team), false);
  assert.equal(isCurrentIEditChunk(candidate(protectedChunk), guest), false);
  assert.ok(board.chunks.filter(chunk => chunk.content.includes('Public selected')).every(chunk => chunk.accessScope === 'public'));
  assert.equal(views.length, 4);
  assert.equal(views[2].roleId, 'role-team');
});

test('authenticated scope is enforced even if a resolver accidentally returns protected copy to a guest', async () => {
  const result = await snapshot(database({ elements: [element('g', { element_type: 'gallery' })] }), {
    visibilityCtx: scope({ isAuthenticated: false }),
    resolveDynamic: async () => ({ sections: [{ text: 'Guest-safe', accessScope: 'public' }, { text: 'Never guest', accessScope: 'authenticated' }], coverage: [], dependencies: [] }),
  });
  assert.match(text(result), /Guest-safe/);
  assert.doesNotMatch(text(result), /Never guest/);
});

test('live chunk proofs reject changed copy/title/order/selection/dependency/scope and forged content', async () => {
  const selected = element('selected', { element_type: 'card_deck', content: { heading: 'Deck header', cardIds: ['selected-card'] } });
  const db = database({ elements: [selected] });
  let dependencyId = 'selected-card';
  let dynamicText = 'Selected card editorial copy';
  let accessScope = 'public';
  const options = { resolveDynamic: async () => ({
    sections: [{ text: dynamicText, accessScope, provenance: { dependencies: [{ table: 'card_deck', id: dependencyId, tenantId: TENANT }] } }], coverage: [], dependencies: [],
  }) };
  const initial = await snapshot(db, options);
  const saved = candidate(initial.chunks.find(chunk => chunk.content.includes(dynamicText)));
  assert.equal(isCurrentIEditChunk(saved, await snapshot(db, options)), true);
  assert.equal(isCurrentIEditChunk({ ...saved, content: `${saved.content} injected` }, initial), false);
  // Source-level history citations may safely narrow a public supporting
  // section to authenticated. The inverse must never broaden protected copy.
  assert.equal(isCurrentIEditChunk({ ...saved, access_scope: 'authenticated' }, initial), true);
  assert.equal(isCurrentIEditChunk({ ...saved, provenance: {} }, initial), false);
  assert.equal(isCurrentIEditChunk(saved, { item: null, chunks: [] }), false);
  assert.equal(isCurrentIEditChunk(null, initial), false);
  const assertStale = async () => assert.equal(isCurrentIEditChunk(saved, await snapshot(db, options)), false);
  dynamicText = 'Edited card'; await assertStale(); dynamicText = 'Selected card editorial copy';
  dependencyId = 'another-card'; await assertStale(); dependencyId = 'selected-card';
  accessScope = 'authenticated'; await assertStale(); accessScope = 'public';
  db.state.tables.i_edit_page[0].title = 'Edited page'; await assertStale(); db.state.tables.i_edit_page[0].title = 'Canonical page';
  selected.display_order = 99; await assertStale(); selected.display_order = 0;
  selected.content.heading = 'Different source context'; await assertStale(); selected.content.heading = 'Deck header';
  db.state.tables.i_edit_page_element = []; await assertStale();
});

test('unknown element or failed dynamic resolution rejects entire snapshot even after valid authored copy', async () => {
  const unknown = database({ elements: [element('valid'), element('unknown', { element_type: 'new_unaudited_block', display_order: 1 })] });
  await assert.rejects(snapshot(unknown), /Unsupported iEdit element type/);
  const failed = database({ elements: [element('valid'), element('dynamic', { element_type: 'gallery', display_order: 1 })] });
  await assert.rejects(snapshot(failed, { resolveDynamic: async () => { throw new Error('Controlled dependency failure'); } }), /Controlled dependency failure/);
});

test('writer acceptance: claim precedes canonical reads, fake knowledge RPC publishes canonical proof, never caller content', async () => {
  const db = database();
  const result = await write(db);
  assert.equal(result.removed, false);
  assert.equal(result.chunks, db.state.published.length);
  const claimIndex = db.operations.findIndex(call => call.rpc === 'claim_member_content_generation');
  const pageIndex = db.operations.findIndex(call => call.table === 'i_edit_page');
  assert.ok(claimIndex >= 0 && claimIndex < pageIndex);
  assert.ok(db.state.published.length);
  for (const row of db.state.published) {
    assert.equal(row.content_type, 'iedit_page');
    assert.equal(row.tenant_id, TENANT);
    assert.equal(row.source_id, SOURCE);
    assert.equal(row.source_generation, 1);
    assert.equal(row.provenance.adapter, 'iedit_page');
    assert.equal(row.access_scope, 'public');
    assert.doesNotMatch(row.content, /UNTRUSTED/);
  }
  assert.ok(!db.operations.some(call => call.rpc === 'publish_member_content_repair'));
  assert.ok(!db.operations.some(call => call.table === 'member_content_chunk' && call.operation !== 'select'));
});

test('writer acceptance: concurrent edit during embedding fences stale publication and stale lease release', async () => {
  const db = database();
  db.state.published = [{ content: 'Previously active safe generation' }];
  await assert.rejects(write(db, {
    embedTexts: async (_client, inputs) => {
      db.state.generation = 2;
      db.state.claimToken = 'newer-worker-claim';
      db.state.tables.i_edit_page_element[0].content.text = 'Current edit';
      return inputs.map(() => [1, 2]);
    },
  }), error => error.code === MEMBER_CONTENT_GENERATION_STALE);
  assert.deepEqual(db.state.published, [{ content: 'Previously active safe generation' }]);
  assert.equal(db.state.claimToken, 'newer-worker-claim', 'late release cannot clear a newer worker lease');
  assert.equal(db.state.publicationAttempts.length, 1);
  assert.equal(db.state.publicationAttempts[0].p_generation, 1);
  const release = db.operations.find(call => call.table === 'member_content_source' && call.operation === 'update');
  assert.deepEqual(release.filters, { tenant_id: TENANT, content_type: 'iedit_page', source_id: SOURCE, generation: 1, claim_token: 'claim-1' });
});

test('writer acceptance: public and audience-protected dynamic evidence retain independent scopes and display proofs', async () => {
  const db = database({ elements: [element('resources', { element_type: 'resources_showcase', content: { headerText: 'Selected resources' } })] });
  const resolveDynamic = async () => ({
    sections: [
      { text: 'Public resource', accessScope: 'public', provenance: { dependencies: [{ table: 'resource', id: 'public-resource', tenantId: TENANT }] } },
      { text: 'Protected resource', accessScope: 'authenticated', provenance: { dependencies: [{ table: 'resource', id: 'protected-resource', tenantId: TENANT }] } },
    ],
    coverage: [{ code: 'audience_projection' }], dependencies: [],
  });
  await write(db, { buildSnapshot: options => snapshot(db, { ...options, resolveDynamic }) });
  const publicRow = db.state.published.find(row => row.content.includes('Public resource'));
  const protectedRow = db.state.published.find(row => row.content.includes('Protected resource'));
  assert.equal(publicRow.access_scope, 'public');
  assert.equal(protectedRow.access_scope, 'authenticated');
  assert.notEqual(publicRow.provenance.iedit.sectionKey, protectedRow.provenance.iedit.sectionKey);
  assert.deepEqual(protectedRow.provenance.iedit.displayDependencies, [{ table: 'resource', id: 'protected-resource', tenantId: TENANT }]);
  assert.deepEqual(protectedRow.provenance.dependencies, []);
  assert.match(protectedRow.content, /Selected resources/);
  assert.doesNotMatch(publicRow.content, /Protected resource/);
});

test('writer acceptance: unknown blocks and incomplete reads never embed or attempt publication', async () => {
  const cases = [
    database({ elements: [element('unknown', { element_type: 'new_unaudited_block' })] }),
    database({ response: call => call.table === 'i_edit_page_element' ? { data: [], count: 1 } : undefined }),
  ];
  for (const db of cases) {
    let embedded = false;
    await assert.rejects(write(db, { embedTexts: async () => { embedded = true; throw new Error('Must not embed'); } }), /Unsupported iEdit|IEDIT_ELEMENTS_INCOMPLETE/);
    assert.equal(embedded, false);
    assert.deepEqual(db.state.publicationAttempts, []);
    assert.ok(db.operations.some(call => call.table === 'member_content_source' && call.operation === 'update'));
  }
});

test('writer acceptance: missing/draft pages publish an empty generation without embedding; zero budget fails before provider', async () => {
  const missing = database({ source: null });
  assert.equal((await write(missing, { embedTexts: async () => { throw new Error('Must not embed'); } })).removed, true);
  assert.deepEqual(missing.state.publicationAttempts[0].p_rows, []);
  const draft = database({ source: page({ status: 'draft' }) });
  assert.equal((await write(draft, { embedTexts: async () => { throw new Error('Must not embed'); } })).removed, true);
  const budget = database();
  await assert.rejects(write(budget, { embeddingBudget: { maxEmbeddingChunks: 0 }, embedTexts: async () => { throw new Error('Must not embed'); } }), error => error.code === MEMBER_CONTENT_EMBEDDING_BUDGET);
  assert.deepEqual(budget.state.publicationAttempts, []);
});

function registry(type = 'iedit_page', id = SOURCE) {
  return { tenant_id: TENANT, content_type: type, source_id: id, active_generation: 1 };
}

function indexedChunk(chunk, source, index = 0) {
  return {
    ...source, id: `fixture-chunk-${index}`, content_type: 'iedit_page', source_id: SOURCE,
    source_generation: 1, access_scope: chunk.accessScope, content: chunk.content,
    provenance: structuredClone(chunk.provenance), similarity: 0.95,
  };
}

// Editorial records here are explicitly synthetic fixture identities, not a
// claim about the current real Graduate Futures board. The CEO name below is
// the one supplied in the reported conversation, used only as regression input.
async function rosterFixture(options = {}) {
  const owned = rows => rows.map(row => ({ tenant_id: TENANT, is_active: true, ...row }));
  const db = database({
    source: page({ title: 'Graduate Futures Institute board', slug: 'board' }),
    elements: [element('board', { element_type: 'wall_of_fame', content: { heading_text: 'Our board', section_id: 'board-section' } })],
    tables: {
      member_content_source: [registry(), registry('news_post', 'ceo-news')],
      resource_category: [],
      news_post: [{
        id: 'ceo-news', tenant_id: TENANT, status: 'published', title: 'Fixture CEO announcement',
        slug: 'fixture-ceo-announcement', published_date: '2020-01-01T00:00:00Z',
      }],
      wall_of_fame_section: owned([{ id: 'board-section', name: 'Graduate Futures Institute board' }]),
      wall_of_fame_category: owned([{ id: 'board-category', section_id: 'board-section', name: 'Board directors' }]),
      wall_of_fame_person: owned([
        { id: 'fixture-chair', category_id: 'board-category', first_name: 'Fixture', last_name: 'Boardchair', job_title: 'Chair', biography: 'Fixture chair editorial biography.' },
        { id: 'fixture-trustee', category_id: 'board-category', first_name: 'Fixture', last_name: 'Trustee', job_title: 'Trustee', biography: 'Fixture trustee editorial biography.' },
      ]),
    },
    ...options,
  });
  const indexed = await snapshot(db);
  const roster = indexed.chunks.find(chunk =>
    chunk.provenance.iedit.displayDependencies.filter(dep => dep.table === 'wall_of_fame_person').length === 2);
  assert.ok(roster, 'real dynamic resolver must produce a compact selected-category roster before biography details');
  const rosterCandidate = indexedChunk(roster, db.state.tables.i_edit_page[0]);
  const newsCandidate = {
    id: 'fixture-ceo-news-chunk', tenant_id: TENANT, content_type: 'news_post', source_id: 'ceo-news',
    source_generation: 1, status: 'published', title: 'Fixture CEO announcement',
    content: 'Martin Edmondson is the CEO of Graduate Futures.', published_date: '2020-01-01T00:00:00Z',
    feature_key: 'content.news', similarity: 0.95, provenance: { dependencies: [] },
  };
  return { db, indexed, rosterCandidate, newsCandidate };
}

const revalidate = (db, candidates, visibilityCtx = scope()) => contentAccess.revalidateMemberContentCandidates({
  supabase: db, candidates, visibilityCtx: { canAccessFeature: () => true, groupIds: new Set(), ...visibilityCtx },
  accessibleEventIds: new Set(), accessibleSessionIds: new Set(),
});

test('real card-deck generation publishes selected text and live revalidation rejects changed/deactivated/removed cards', async () => {
  async function fixture() {
    const db = database({
      elements: [element('cards', { element_type: 'card_deck',
        content: { heading: 'Our programmes', cardIds: ['missing', 'inactive', 'foreign', 'b', 'a'], cardCount: 2 } })],
      tables: {
        member_content_source: [registry()],
        card_deck: [
          { id: 'a', tenant_id: TENANT, status: 'active', title: 'Programme A', description: 'Description A' },
          { id: 'b', tenant_id: TENANT, status: 'active', title: 'Programme B', description: '<p>Description B</p>',
            links: [{ text: 'Programme details', url: 'https://example.test/details' }],
            target_url: 'https://example.test', button_text: 'Apply now' },
          { id: 'inactive', tenant_id: TENANT, status: 'inactive', title: 'Hidden inactive' },
          { id: 'foreign', tenant_id: 'another-tenant', status: 'active', title: 'Hidden foreign' },
        ],
      },
    });
    await write(db); // Real dynamic resolver, real adapter and publication path.
    const rows = db.state.published.filter(row => row.provenance.iedit.displayDependencies.some(dep => dep.table === 'card_deck'));
    assert.equal(rows.length, 2);
    assert.match(rows[0].content, /Our programmes[\s\S]*Programme B[\s\S]*Description B[\s\S]*Programme details[\s\S]*Apply now/);
    assert.match(rows[1].content, /Programme A/);
    assert.doesNotMatch(rows.map(row => row.content).join('\n'), /Hidden|https:/);
    assert.deepEqual(rows[0].provenance.iedit.displayDependencies, [{ table: 'card_deck', id: 'b', tenantId: TENANT }]);
    return { db, saved: { ...db.state.tables.i_edit_page[0], ...rows[0], id: 'card-chunk' } };
  }
  const initial = await fixture();
  assert.equal((await revalidate(initial.db, [initial.saved], scope({ isAuthenticated: false }))).length, 1);
  for (const mutate of [
    db => { db.state.tables.card_deck[1].description = 'Changed description'; },
    db => { db.state.tables.card_deck[1].status = 'inactive'; },
    db => { db.state.tables.card_deck[1].tenant_id = 'another-tenant'; },
    db => { db.state.tables.card_deck = db.state.tables.card_deck.filter(row => row.id !== 'b'); },
    db => { db.state.tables.i_edit_page_element[0].content.cardIds = ['a']; },
    db => { db.state.tables.i_edit_page_element[0].content.cardCount = 0; },
    db => { db.state.tables.i_edit_page_element[0].content.showCardDescription = false; },
    db => { db.state.tables.i_edit_page_element[0].content.showCardButton = false; },
  ]) {
    const fresh = await fixture();
    mutate(fresh.db);
    assert.deepEqual(await revalidate(fresh.db, [fresh.saved]), []);
  }
});

test('failed card-deck load aborts generation before embeddings and denies saved evidence', async () => {
  let failed = false;
  const db = database({
    elements: [element('cards', { element_type: 'card_deck', content: { heading: 'Wrapper', cardIds: ['a'] } })],
    tables: { member_content_source: [registry()], card_deck: [{ id: 'a', tenant_id: TENANT, status: 'active', title: 'Card title' }] },
    response: call => failed && call.table === 'card_deck' ? { error: { message: 'Card provider failed' } } : undefined,
  });
  const before = await snapshot(db);
  const saved = indexedChunk(before.chunks.find(chunk => chunk.content.includes('Card title')), page());
  failed = true;
  let embedded = false;
  await assert.rejects(write(db, { embedTexts: async () => { embedded = true; return []; } }), /Card provider failed/);
  assert.equal(embedded, false);
  assert.equal(db.state.publicationAttempts.length, 0);
  assert.deepEqual(await revalidate(db, [saved]), []);
});

test('real source Access gate rebuilds selected roster and denies changed membership, selection, status, tenant or generation', async () => {
  const { db, rosterCandidate } = await rosterFixture();
  const eligible = await revalidate(db, [rosterCandidate]);
  assert.equal(eligible.length, 1);
  assert.equal(eligible[0].link, '/board');
  assert.equal(eligible[0].title, 'Graduate Futures Institute board');
  const reads = db.operations.filter(call => call.table === 'member_content_source');
  assert.equal(reads.length, 2, 'source registry must be reread after the dynamic snapshot');
  for (const mutate of [
    fixture => { fixture.state.tables.wall_of_fame_person[1].is_active = false; },
    fixture => { fixture.state.tables.wall_of_fame_person[1].category_id = 'another-category'; },
    fixture => { fixture.state.tables.i_edit_page_element[0].content.section_id = 'another-section'; },
    fixture => { fixture.state.tables.i_edit_page[0].status = 'draft'; },
    fixture => { fixture.state.tables.i_edit_page[0].tenant_id = 'another-tenant'; },
    fixture => { fixture.state.tables.member_content_source[0].active_generation = 2; },
  ]) {
    const fresh = await rosterFixture();
    mutate(fresh.db);
    assert.deepEqual(await revalidate(fresh.db, [fresh.rosterCandidate]), []);
  }
});

test('real source Access gate closes the concurrent generation change window during dynamic reads', async () => {
  let mutateDuringLiveRead = false;
  const { db, rosterCandidate } = await rosterFixture({
    response: (call, state) => {
      if (mutateDuringLiveRead && call.table === 'wall_of_fame_person') {
        state.tables.member_content_source[0].active_generation = 2;
      }
      return undefined;
    },
  });
  mutateDuringLiveRead = true;
  assert.deepEqual(await revalidate(db, [rosterCandidate]), []);
  const reads = db.operations.filter(call => call.table === 'member_content_source');
  assert.equal(reads.length, 2);
});

test('real source Access gate evaluates current resource roles inside a public iEdit page', async () => {
  const db = database({
    elements: [element('protected-resources', { element_type: 'resources_showcase', content: { headerText: 'Board resources', resourceIds: ['board-resource'] } })],
    tables: {
      member_content_source: [registry()], resource_category: [],
      resource: [{
        id: 'board-resource', tenant_id: TENANT, status: 'active', title: 'Protected board report',
        description: 'Board-only editorial report.', is_public: false, allowed_role_ids: ['role-board'],
        member_group_id: null, linked_events: [], subcategories: [], release_date: '2020-01-01',
      }],
    },
  });
  const indexed = await snapshot(db);
  const proof = indexed.chunks.find(chunk => chunk.content.includes('Protected board report'));
  assert.ok(proof);
  const evidence = indexedChunk(proof, db.state.tables.i_edit_page[0]);
  assert.equal(evidence.access_scope, 'authenticated');
  assert.equal((await revalidate(db, [evidence], scope())).length, 1);
  assert.deepEqual(await revalidate(db, [evidence], scope({ roleId: 'role-team' })), []);
  assert.deepEqual(await revalidate(db, [evidence], scope({ isAuthenticated: false, roleId: null })), []);
  db.state.tables.resource[0].allowed_role_ids = ['role-team'];
  assert.deepEqual(await revalidate(db, [evidence], scope()), []);
});

test('real source Access gate denies an inactive microsite and failed/partial dynamic source reads', async () => {
  const { db, rosterCandidate } = await rosterFixture();
  db.state.tables.i_edit_page[0].microsite_id = 'fixture-site';
  db.state.tables.microsite = [{ id: 'fixture-site', tenant_id: TENANT, path_prefix: 'partners', is_active: true }];
  assert.equal((await revalidate(db, [rosterCandidate]))[0].link, '/partners/board');
  db.state.tables.microsite[0].is_active = false;
  assert.deepEqual(await revalidate(db, [rosterCandidate]), []);
  for (const answer of [{ data: null, error: new Error('Controlled source failure') }, { data: [], count: 2 }]) {
    const broken = await rosterFixture({
      response: (call, state) => state.failLiveRead && call.table === 'wall_of_fame_person' ? answer : undefined,
    });
    broken.db.state.failLiveRead = true;
    assert.deepEqual(await revalidate(broken.db, [broken.rosterCandidate]), []);
  }
});

// Execute the actual endpoint source with only infrastructure injected, as in
// memberAiRetrieval.test.mjs. The real revalidateMemberContentCandidates,
// snapshot adapter, dynamic resolver, visibility and citation code stay intact.
function askHandler(db, FakeOpenAI) {
  const source = readFileSync(new URL('../member-ai/ask.js', import.meta.url), 'utf8')
    .replace(/^import [\s\S]*? from .*?;\s*$/gm, '')
    .replace(/^export \{.*?;\s*$/gm, '')
    .replace(/^export async function /gm, 'async function ')
    .replace(/^export function /gm, 'function ')
    .replace('export default async function handler', 'async function handler');
  const member = { id: 'fixture-viewer', tenant_id: TENANT, role_id: 'role-board' };
  const injected = {
    ...contentAccess, ...answerHelpers, ...ranking,
    fetchCategoriesWithAccess, computeHiddenSubcategories, buildResponsePolicyInstructions, noEvidenceResponse,
    OpenAI: FakeOpenAI, supabase: db, isChunkVisibleToMember,
    loadTenantAiAssistant: async () => ({ enabled: true, responsePolicy: normalizeResponsePolicy(null) }),
    getTenantContext: async () => ({ tenantId: TENANT, isAuthenticated: true }),
    getSessionMember: async () => member, getSessionTenantUser: async () => null,
    resolveMemberExclusions: async () => [],
    makeFeatureAccessChecker: () => ({ canAccessFeature: () => true }),
    // No bookings, groups or PDFs in this fixture. Do not replace source-level
    // revalidation: these stubs only avoid unrelated identity/aggregate reads.
    resolveMemberContentGroupIds: async () => new Set(),
    resolveAccessibleEventIds: async () => new Set(),
    resolveAccessibleSessionIds: async () => new Set(),
    resolvePreRankEligiblePdfChunkIds: async () => [],
    looksLikeStructuredQuestion: () => false,
    reserveMemberAiUsage: async () => ({ allowed: true, reservationId: 'fixture-request' }),
    finishMemberAiUsage: async () => {},
    getMemberAiSettings: async () => ({ allowed_content_types: ['iedit_page', 'news_post'] }),
  };
  return new Function(...Object.keys(injected), `${source}\nreturn handler;`)(...Object.values(injected));
}
const httpResponse = () => ({
  statusCode: 200, setHeader() {},
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});

async function askFixture({ duringSynthesis } = {}) {
  const fixture = await rosterFixture();
  const trace = { searches: [], embeddings: [], expansionInputs: [], synthesis: [] };
  fixture.db.rpc = async (name, args) => {
    assert.equal(name, 'match_member_content_chunks');
    trace.searches.push(structuredClone(args));
    return { data: [args.p_query_text === 'Who is the CEO of Graduate Futures' ? fixture.newsCandidate : fixture.rosterCandidate], error: null };
  };
  class FakeOpenAI {
    embeddings = { create: async request => {
      trace.embeddings.push(structuredClone(request.input));
      return { data: request.input.map(() => ({ embedding: Array(1536).fill(0) })) };
    } };
    chat = { completions: { create: async request => {
      if (request.response_format?.type === 'json_object') {
        trace.expansionInputs.push(structuredClone(request.messages));
        return { choices: [{ message: { content: '{"queries":[]}' } }] };
      }
      trace.synthesis.push(structuredClone(request.messages));
      await duringSynthesis?.(fixture, request);
      const latest = request.messages.at(-1).content;
      assert.match(latest, /\[S1\]/, 'the fake provider only receives a currently eligible citation');
      const answer = latest.includes('Question: Who is the CEO')
        ? 'Martin Edmondson is the CEO of Graduate Futures [S1].'
        : 'The fixture board roster contains Fixture Boardchair and Fixture Trustee [S1].';
      return { choices: [{ message: { content: answer } }] };
    } } };
  }
  return { ...fixture, trace, ask: askHandler(fixture.db, FakeOpenAI) };
}

async function withFakeProviderKey(run) {
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'isolated-fixture-not-a-real-key';
  try { await run(); } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
}

test('actual ask direct-board regression accepts canonical roster and citation without changing the literal query', async () => withFakeProviderKey(async () => {
  const { ask, trace } = await askFixture();
  const question = 'Who is on Graduate Futures Institute’s board?';
  const res = httpResponse();
  await ask({ method: 'POST', headers: {}, body: { question } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.grounded, true);
  assert.equal(res.body.sources.length, 1);
  assert.equal(res.body.sources[0].type, 'iedit_page');
  assert.equal(res.body.sources[0].link, '/board');
  assert.match(res.body.answer, /Fixture Boardchair.*Fixture Trustee/);
  assert.deepEqual(trace.embeddings, [[question]]);
  assert.deepEqual(trace.searches.map(args => args.p_query_text), [question]);
  assert.match(trace.synthesis[0].at(-1).content, /Fixture Boardchair.*Chair[\s\S]*Fixture Trustee.*Trustee/);
  assert.ok(trace.synthesis[0].at(-1).content.endsWith(`Question: ${question}`));
}));

test('actual ask original CEO then board follow-up regression uses unchanged follow-up query and current iEdit evidence', async () => withFakeProviderKey(async () => {
  const { ask, trace } = await askFixture();
  const firstQuestion = 'Who is the CEO of Graduate Futures';
  const followUp = 'Who else is on the board?';
  const first = httpResponse();
  await ask({ method: 'POST', headers: {}, body: { question: firstQuestion } }, first);
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.grounded, true);
  assert.match(first.body.answer, /Martin Edmondson/);
  assert.equal(first.body.sources[0].type, 'news_post');
  const second = httpResponse();
  await ask({ method: 'POST', headers: {}, body: {
    question: followUp, history: [
      { role: 'user', content: firstQuestion },
      { role: 'assistant', content: first.body.answer },
    ],
  } }, second);
  assert.equal(second.statusCode, 200);
  assert.equal(second.body.grounded, true);
  assert.equal(second.body.sources[0].type, 'iedit_page');
  assert.equal(second.body.sources[0].link, '/board');
  assert.match(second.body.answer, /Fixture Boardchair.*Fixture Trustee/);
  assert.deepEqual(trace.embeddings, [[firstQuestion], [followUp]]);
  assert.deepEqual(trace.searches.map(args => args.p_query_text), [firstQuestion, followUp]);
  assert.equal(trace.synthesis.length, 2);
  assert.ok(trace.synthesis[1].some(message => message.role === 'user' && message.content === firstQuestion));
  assert.ok(!trace.synthesis[1].some(message => message.role === 'assistant'), 'old model facts are not replayed as authority');
  assert.ok(trace.synthesis[1].at(-1).content.endsWith(`Question: ${followUp}`));
  assert.ok(trace.expansionInputs.every(messages => !JSON.stringify(messages).includes(first.body.answer)));
}));

test('actual ask rechecks source Access after synthesis and suppresses revoked roster facts, citations and grounded answer', async () => withFakeProviderKey(async () => {
  const fixture = await askFixture({
    duringSynthesis: async ({ db }) => { db.state.tables.wall_of_fame_person[1].is_active = false; },
  });
  const res = httpResponse();
  await fixture.ask({ method: 'POST', headers: {}, body: { question: 'Who else is on the board?' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(fixture.trace.synthesis.length, 1, 'the roster was initially eligible before revocation');
  assert.equal(res.body.grounded, false);
  assert.deepEqual(res.body.sources, []);
  assert.doesNotMatch(res.body.answer, /Fixture Boardchair|Fixture Trustee/);
  assert.equal(res.body.answerProvenance, undefined);
}));
