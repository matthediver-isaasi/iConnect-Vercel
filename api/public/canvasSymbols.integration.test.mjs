import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

import { projectMemberOnlyGuest } from '../../shared/canvasMemberOnly.js';
import { resolveSymbolsInDesign } from '../../client/src/lib/canvasDesign.js';

const TENANT_ID = 'tenant-a';
const SYMBOL_ID = 'shared-symbol';
const ADMIN = {
  tenantId: TENANT_ID,
  tenantUserId: 'admin-a',
  isAuthenticated: true,
};

// Follow the canvas-design/pageMetadata test's VM harness: evaluate the actual
// route bodies with explicit dependencies, never importing the live DB/auth/
// reindex module graph. The public projection and symbol resolver remain real.
const paths = {
  record: '../canvas-symbols/[id].js',
  collection: '../canvas-symbols/index.js',
  page: './page/[slug].js',
  fallback: './canvas-symbols.js',
  viewer: '../_lib/canvasMemberOnly.js',
};
const sources = Object.fromEntries(await Promise.all(
  Object.entries(paths).map(async ([key, path]) => [
    key,
    (await readFile(new URL(path, import.meta.url), 'utf8'))
      .replace(/^import\b[\s\S]*?;\r?$/gm, '')
      .replace(/^export (?:default )?/gm, ''),
  ])
));

function evaluate(key, exports, dependencies) {
  return vm.runInNewContext(
    `${sources[key]}\n({ ${exports.join(', ')} })`,
    dependencies,
    { filename: new URL(paths[key], import.meta.url).pathname }
  );
}

function design(children) {
  return {
    version: 1,
    root: { sections: [{ id: 'section-1', children }] },
  };
}

function textBlock(text = 'Original shared text') {
  return {
    id: 'shared-text',
    type: 'text',
    content: { text },
    bp: { desktop: { x: 0, y: 0, w: 240, h: 50 } },
  };
}

function fixtureRows() {
  const symbol = {
    id: SYMBOL_ID,
    tenant_id: TENANT_ID,
    name: 'Shared notice',
    description: 'Reusable notice',
    design: design([textBlock()]),
    updated_at: '2026-01-01T00:00:00.000Z',
  };
  const pages = ['first', 'second'].map((slug, index) => ({
    id: `page-${slug}`,
    tenant_id: TENANT_ID,
    slug,
    title: `${slug} published page`,
    status: 'published',
    layout_type: 'public',
    builder_type: 'canvas',
    canvas_design: design([
      ...[0, 1].map(instance => ({
        id: `${slug}-instance-${instance}`,
        type: 'symbol',
        content: { symbolId: SYMBOL_ID },
        bp: { desktop: { x: 20 + instance * 300, y: 100 + index * 100, w: 240, h: 50 } },
      })),
      { ...structuredClone(symbol.design.root.sections[0].children[0]), id: `${slug}-detached` },
    ]),
    updated_at: '2026-01-01T00:00:00.000Z',
  }));
  return {
    canvas_symbol: [
      symbol,
      { ...structuredClone(symbol), id: 'foreign-symbol', tenant_id: 'tenant-b', name: 'Foreign secret' },
      { ...structuredClone(symbol), id: 'draft-only-symbol', name: 'Unpublished secret' },
    ],
    i_edit_page: [
      ...pages,
      {
        ...structuredClone(pages[0]),
        id: 'draft-page',
        slug: 'draft',
        status: 'draft',
        canvas_design: design([{ id: 'draft-instance', type: 'symbol', content: { symbolId: 'draft-only-symbol' } }]),
      },
      {
        ...structuredClone(pages[0]),
        id: 'foreign-page',
        tenant_id: 'tenant-b',
        canvas_design: design([{ id: 'foreign-instance', type: 'symbol', content: { symbolId: 'foreign-symbol' } }]),
      },
    ],
  };
}

function makeDb(initialRows = fixtureRows()) {
  const rows = structuredClone(initialRows);
  const queries = [];
  return {
    rows,
    queries,
    from(table) {
      assert.ok(Object.hasOwn(rows, table), `Unexpected table: ${table}`);
      const state = { table, operation: 'read', filters: [], columns: '*' };
      queries.push(state);
      let patch;
      let cardinality = 'many';
      const query = {
        select(columns = '*') { state.columns = columns; return query; },
        eq(key, value) { state.filters.push({ key, value, operator: 'eq' }); return query; },
        in(key, value) { state.filters.push({ key, value: [...value], operator: 'in' }); return query; },
        order() { return query; },
        update(value) { state.operation = 'update'; patch = structuredClone(value); return query; },
        insert(value) { state.operation = 'insert'; patch = structuredClone(value); return query; },
        delete() { state.operation = 'delete'; return query; },
        single() { cardinality = 'single'; return query; },
        maybeSingle() { cardinality = 'maybe'; return query; },
        then(resolve, reject) {
          const matches = state.operation === 'insert' ? [] : rows[table].filter(row => state.filters.every(filter => (
            filter.operator === 'in'
              ? filter.value.includes(row[filter.key])
              : row[filter.key] === filter.value
          )));
          if (state.operation === 'insert') {
            const row = { id: 'created-symbol', ...patch };
            rows[table].push(row);
            matches.push(row);
          }
          if (state.operation === 'update') {
            for (const row of matches) Object.assign(row, structuredClone(patch));
          }
          if (state.operation === 'delete') {
            rows[table] = rows[table].filter(row => !matches.includes(row));
          }
          const selected = matches.map(row => (
            state.columns === '*'
              ? structuredClone(row)
              : Object.fromEntries(state.columns.split(',').map(column => {
                const key = column.trim();
                return [key, structuredClone(row[key])];
              }))
          ));
          // Supabase .single() fails on zero rows; .maybeSingle() does not.
          // In particular, never fabricate an updated row for a tenant miss.
          const error = cardinality === 'single' && selected.length !== 1
            ? { code: 'PGRST116', message: 'Expected exactly one row' }
            : null;
          return Promise.resolve({
            data: error ? null : cardinality === 'many' ? selected : selected[0] || null,
            error,
          }).then(resolve, reject);
        },
      };
      return query;
    },
  };
}

function responseMock() {
  return {
    statusCode: 200,
    body: undefined,
    headers: new Map(),
    setHeader(name, value) { this.headers.set(name, value); },
    getHeader(name) { return this.headers.get(name); },
    status(code) { this.statusCode = code; return this; },
    // Model the HTTP serialization boundary, not shared references to DB rows.
    json(body) { this.body = JSON.parse(JSON.stringify(body)); return this; },
  };
}

function harness({ context = ADMIN, featureAccess = false, reindexError = false } = {}) {
  const db = makeDb();
  const featureChecks = [];
  const reindexes = [];
  const getTenantContext = async () => context;
  const dependencies = {
    supabase: db,
    getTenantContext,
    hasFeatureAccess: async (roleId, feature) => {
      featureChecks.push({ roleId, feature });
      return featureAccess;
    },
    reindexMemberContentEntitySafe: async (type, row) => {
      reindexes.push({ type, row: structuredClone(row) });
      if (reindexError) throw new Error('Controlled reindex failure');
    },
    console,
  };
  const record = evaluate('record', ['handler'], dependencies).handler;
  const collection = evaluate('collection', ['handler'], dependencies).handler;
  const viewerHelpers = evaluate('viewer', [
    'setMemberContentCacheHeaders', 'resolveCanvasViewer',
  ], { getTenantContext, console });
  const publicDependencies = {
    supabase: db,
    resolveTenantFromRequest: async () => ({ id: TENANT_ID }),
    resolveMicrositeByPrefix: async () => { throw new Error('Unexpected microsite lookup'); },
    projectMemberOnlyGuest,
    ...viewerHelpers,
    console,
  };
  const pageFactory = evaluate('page', ['createPublicPageHandler'], publicDependencies).createPublicPageHandler;
  const fallbackFactory = evaluate('fallback', ['createCanvasSymbolsHandler'], publicDependencies).createCanvasSymbolsHandler;
  return {
    db,
    featureChecks,
    reindexes,
    record,
    collection,
    publicHandlers(allowMemberOnlyContent = false) {
      const options = {
        db,
        resolveTenant: async () => ({ id: TENANT_ID }),
        resolveViewer: async () => ({ allowMemberOnlyContent }),
      };
      return { page: pageFactory(options), fallback: fallbackFactory(options) };
    },
  };
}

async function invoke(handler, { method = 'GET', query = { id: SYMBOL_ID }, body } = {}) {
  const res = responseMock();
  await handler({ method, query, body, headers: { host: 'tenant-a.example.test' } }, res);
  return res;
}

for (const method of ['GET', 'PATCH']) {
  for (const roleId of [null, 'ordinary-member-role']) {
    test(`${method} symbol denies authenticated non-admin without page-editor permission (${roleId || 'no role'})`, async () => {
      const fixture = harness({
        context: { tenantId: TENANT_ID, memberId: 'member-a', roleId, isAuthenticated: true },
      });
      const before = JSON.stringify(fixture.db.rows);
      const res = await invoke(fixture.record, { method, body: { design: design([textBlock('Denied change')]) } });
      assert.equal(res.statusCode, 404);
      assert.deepEqual(res.body, { error: 'Symbol not found' });
      assert.equal(fixture.db.queries.length, 0, 'deny before querying authoring assets');
      assert.deepEqual(fixture.featureChecks, roleId ? [{ roleId, feature: 'site-builder.page-editor' }] : []);
      assert.equal(fixture.reindexes.length, 0);
      assert.equal(JSON.stringify(fixture.db.rows), before);
    });
  }

  test(`${method} cannot read or mutate another tenant's symbol even as an authenticated admin`, async () => {
    const fixture = harness({ context: { ...ADMIN, tenantId: 'tenant-b', tenantUserId: 'admin-b' } });
    const before = JSON.stringify(fixture.db.rows);
    const res = await invoke(fixture.record, { method, body: { name: 'Denied name', design: design([textBlock('Denied change')]) } });
    // The existing PATCH route translates the .single() tenant miss into a
    // generic 500, while GET uses a non-disclosing 404. Both must deny access.
    assert.equal(res.statusCode, method === 'GET' ? 404 : 500);
    assert.deepEqual(res.body, { error: method === 'GET' ? 'Symbol not found' : 'Failed to update symbol' });
    assert.deepEqual(fixture.db.queries[0].filters, [
      { key: 'id', value: SYMBOL_ID, operator: 'eq' },
      { key: 'tenant_id', value: 'tenant-b', operator: 'eq' },
    ]);
    assert.equal(JSON.stringify(fixture.db.rows), before);
    assert.equal(fixture.reindexes.length, 0);
  });

  test(`${method} retains the explicit page-editor feature grant for non-admins`, async () => {
    const fixture = harness({
      context: { tenantId: TENANT_ID, memberId: 'editor-a', roleId: 'page-editor-role', isAuthenticated: true },
      featureAccess: true,
    });
    const res = await invoke(fixture.record, { method, body: { name: 'Permitted rename' } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.symbol.id, SYMBOL_ID);
    assert.equal(res.body.symbol.tenant_id, TENANT_ID);
    assert.deepEqual(fixture.featureChecks, [{ roleId: 'page-editor-role', feature: 'site-builder.page-editor' }]);
    assert.equal(fixture.reindexes.length, method === 'PATCH' ? 1 : 0);
  });
}

test('symbol collection GET denies authenticated non-admins before reading designs', async () => {
  const fixture = harness({
    context: { tenantId: TENANT_ID, memberId: 'member-a', roleId: 'ordinary-member-role', isAuthenticated: true },
  });
  const res = await invoke(fixture.collection, { query: { full: '1' } });
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: 'Forbidden' });
  assert.equal(fixture.db.queries.length, 0);
});

for (const method of ['PATCH', 'PUT']) {
  test(`${method} updates only the definition and preserves the CanvasSymbol reindex hook`, async () => {
    const fixture = harness();
    const pagesBefore = JSON.stringify(fixture.db.rows.i_edit_page);
    const otherSymbolsBefore = structuredClone(fixture.db.rows.canvas_symbol.slice(1));
    const updatedDesign = design([textBlock('Updated shared text')]);
    const res = await invoke(fixture.record, { method, body: { design: updatedDesign } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.symbol.design, updatedDesign);
    assert.ok(Number.isFinite(Date.parse(res.body.symbol.updated_at)));
    assert.deepEqual(fixture.reindexes, [{ type: 'CanvasSymbol', row: res.body.symbol }]);
    assert.equal(JSON.stringify(fixture.db.rows.i_edit_page), pagesBefore);
    assert.deepEqual(fixture.db.rows.canvas_symbol.slice(1), otherSymbolsBefore);
    assert.equal(fixture.db.queries.length, 1);
    assert.equal(fixture.db.queries[0].table, 'canvas_symbol');
  });
}

test('symbol create and delete retain their existing lifecycle reindex hooks', async () => {
  const fixture = harness();
  const created = await invoke(fixture.collection, {
    method: 'POST',
    query: {},
    body: { name: 'New symbol', design: design([textBlock('New text')]) },
  });
  assert.equal(created.statusCode, 201);
  assert.deepEqual(fixture.reindexes, [{ type: 'CanvasSymbol', row: created.body.symbol }]);
  const removed = await invoke(fixture.record, { method: 'DELETE' });
  assert.equal(removed.statusCode, 200);
  assert.deepEqual(removed.body, { ok: true });
  assert.deepEqual(fixture.reindexes[1], { type: 'CanvasSymbol', row: { id: SYMBOL_ID, tenant_id: TENANT_ID } });
  assert.equal(fixture.db.rows.canvas_symbol.some(row => row.id === SYMBOL_ID), false);
});

test('failed validation never writes or reindexes; a rejected safe hook does not fail a saved PATCH', async () => {
  const fixture = harness({ reindexError: true });
  const before = JSON.stringify(fixture.db.rows);
  const invalid = await invoke(fixture.record, { method: 'PATCH', body: { design: 'invalid' } });
  assert.equal(invalid.statusCode, 400);
  assert.equal(JSON.stringify(fixture.db.rows), before);
  assert.equal(fixture.db.queries.length, 0);
  assert.equal(fixture.reindexes.length, 0);
  const saved = await invoke(fixture.record, { method: 'PATCH', body: { name: 'Saved despite reindex failure' } });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.body.symbol.name, 'Saved despite reindex failure');
  assert.deepEqual(fixture.reindexes, [{ type: 'CanvasSymbol', row: saved.body.symbol }]);
});

for (const allowMemberOnlyContent of [false, true]) {
  test(`shared definition PATCH reaches every instance on two published pages on next ${allowMemberOnlyContent ? 'member' : 'guest'} read without rewriting detached copies or page documents`, async () => {
    const fixture = harness();
    const { page, fallback } = fixture.publicHandlers(allowMemberOnlyContent);
    const pageDocumentsBefore = JSON.stringify(fixture.db.rows.i_edit_page);
    const beforeReads = new Map();

    async function readAndResolve(slug, expectedText) {
      const res = await invoke(page, { query: { slug } });
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers.get('Cache-Control'), 'private, no-store, must-revalidate');
      assert.deepEqual(res.body.symbols.map(symbol => symbol.id), [SYMBOL_ID], 'only this page\'s tenant-scoped referenced definition');
      const pageBeforeResolution = JSON.stringify(res.body.page);
      const symbolsBeforeResolution = JSON.stringify(res.body.symbols);
      const resolved = resolveSymbolsInDesign(
        res.body.page.canvas_design,
        new Map(res.body.symbols.map(symbol => [symbol.id, symbol]))
      );
      const children = resolved.root.sections[0].children;
      const instances = children.filter(block => block.type === 'symbol');
      assert.equal(instances.length, 2);
      for (const instance of instances) {
        assert.equal(instance.__symbolChildren.length, 1);
        assert.equal(instance.__symbolChildren[0].content.text, expectedText);
      }
      assert.notEqual(instances[0].__symbolChildren[0].id, instances[1].__symbolChildren[0].id);
      const detached = children.find(block => block.id === `${slug}-detached`);
      assert.equal(detached.type, 'text');
      assert.equal(detached.content.text, 'Original shared text');
      assert.equal(detached.content.symbolId, undefined);
      assert.equal(detached.__symbolChildren, undefined);
      assert.equal(JSON.stringify(res.body.page), pageBeforeResolution, 'resolution is a read transform');
      assert.equal(JSON.stringify(res.body.symbols), symbolsBeforeResolution, 'resolution must not mutate definitions');
      return res.body;
    }

    for (const slug of ['first', 'second']) {
      beforeReads.set(slug, await readAndResolve(slug, 'Original shared text'));
    }
    const beforeFallback = await invoke(fallback, { query: {} });
    assert.equal(beforeFallback.statusCode, 200);
    assert.deepEqual(beforeFallback.body.symbols.map(symbol => symbol.id), [SYMBOL_ID]);
    assert.equal(beforeFallback.body.symbols[0].design.root.sections[0].children[0].content.text, 'Original shared text');

    const patch = await invoke(fixture.record, {
      method: 'PATCH',
      body: { design: design([textBlock('Updated shared text')]) },
    });
    assert.equal(patch.statusCode, 200);
    assert.deepEqual(fixture.reindexes, [{ type: 'CanvasSymbol', row: patch.body.symbol }]);

    for (const slug of ['first', 'second']) {
      const after = await readAndResolve(slug, 'Updated shared text');
      assert.deepEqual(after.page, beforeReads.get(slug).page, 'entire public page document stays unchanged');
      assert.equal(beforeReads.get(slug).symbols[0].design.root.sections[0].children[0].content.text, 'Original shared text');
    }
    const afterFallback = await invoke(fallback, { query: {} });
    assert.equal(afterFallback.statusCode, 200);
    assert.equal(afterFallback.headers.get('Cache-Control'), 'private, no-store, must-revalidate');
    assert.deepEqual(afterFallback.body.symbols.map(symbol => symbol.id), [SYMBOL_ID]);
    assert.equal(afterFallback.body.symbols[0].design.root.sections[0].children[0].content.text, 'Updated shared text');
    assert.equal(JSON.stringify(fixture.db.rows.i_edit_page), pageDocumentsBefore, 'all persisted page JSON and timestamps are byte-identical');
    assert.equal(fixture.db.queries.filter(query => query.operation !== 'read').length, 1);
    assert.equal(fixture.db.queries.find(query => query.operation !== 'read').table, 'canvas_symbol');
  });
}