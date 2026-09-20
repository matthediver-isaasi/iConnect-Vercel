import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import previewHandler from './preview.js';

const serviceSlot = '__audienceListServiceFixture';

async function loadCampaignService() {
  const path = resolve('api/_lib/campaignService.js');
  const source = await readFile(path, 'utf8');
  const importPattern = /import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"];?/g;
  const replacements = new Map();

  for (const [, names, specifier] of source.matchAll(importPattern)) {
    if (specifier === 'crypto') continue;
    const exports = [];
    for (const entry of names.replace(/[{}]/g, '').split(',').map((value) => value.trim()).filter(Boolean)) {
      const [imported, local = imported] = entry.split(/\s+as\s+/);
      if (imported === 'supabase') {
        exports.push(`export const ${local} = { from: (...args) => globalThis.${serviceSlot}.db.from(...args) };`);
      } else {
        exports.push(`export function ${local}(...args) { return globalThis.${serviceSlot}.dependency(${JSON.stringify(imported)}, args); }`);
      }
    }
    replacements.set(specifier, exports.join('\n'));
  }

  const result = await build({
    entryPoints: [path],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    plugins: [{
      name: 'audience-list-service-fixture',
      setup(builder) {
        builder.onResolve({ filter: /.*/ }, (args) => {
          if (replacements.has(args.path)) return { path: args.path, namespace: 'fixture' };
        });
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({
          loader: 'js',
          contents: replacements.get(args.path),
        }));
      },
    }],
  });
  const encoded = Buffer.from(result.outputFiles[0].text).toString('base64');
  return import(`data:text/javascript;base64,${encoded}`);
}

function database(rows = {}, { missingReviewSchema = false } = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      const call = { table, select: '', filters: [] };
      calls.push(call);
      let filters = [];
      let range = null;
      const query = {
        select(columns) { call.select = columns; return query; },
        eq(column, value) {
          call.filters.push(['eq', column, value]);
          filters.push((row) => row[column] === value);
          return query;
        },
        in(column, values) {
          call.filters.push(['in', column, [...values]]);
          filters.push((row) => values.includes(row[column]));
          return query;
        },
        order() { return query; },
        range(from, to) { range = [from, to]; return query; },
        single() { return execute(true); },
        then(resolveResult, rejectResult) {
          return execute(false).then(resolveResult, rejectResult);
        },
        catch(rejectResult) { return execute(false).catch(rejectResult); },
      };
      async function execute(single) {
        if (missingReviewSchema && table === 'audience_list' && call.select.includes('category_review_required')) {
          return { data: null, error: { message: 'column audience_list.category_review_required does not exist' } };
        }
        let selected = (rows[table] || []).filter((row) => filters.every((filter) => filter(row)));
        if (range) selected = selected.slice(range[0], range[1] + 1);
        return { data: single ? selected[0] || null : selected, error: null };
      }
      return query;
    },
  };
}

function response() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function endpointDependencies(db, {
  authenticated = true,
  admin = true,
  tenantId = 'tenant-a',
  recipients = [],
} = {}) {
  return {
    supabase: db,
    getTenantContext: async () => ({ isAuthenticated: authenticated, tenantId: authenticated ? tenantId : null }),
    hasAdminAccess: async () => admin,
    getTargetRecipients: async () => ({ success: true, recipients }),
  };
}

test('preview returns a tenant-bound, deduplicated and sorted valid audience list', async () => {
  const db = database({
    audience_list: [
      { id: 'list-a', tenant_id: 'tenant-a', name: 'Customers' },
      { id: 'list-a', tenant_id: 'tenant-b', name: 'Foreign list' },
    ],
  });
  const deps = endpointDependencies(db, {
    recipients: [
      { email: 'z@example.test', first_name: 'Amy', last_name: 'Zulu' },
      { email: 'A@example.test', first_name: 'Bea', last_name: 'Alpha' },
      { email: 'a@example.test', first_name: 'Duplicate', last_name: 'Entry' },
      { email: null, first_name: 'No', last_name: 'Email' },
    ],
  });
  const res = response();

  await previewHandler({ method: 'POST', body: { listId: 'list-a' } }, res, deps);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.listName, 'Customers');
  assert.equal(res.body.totalCount, 2);
  assert.deepEqual(res.body.recipients.map(({ email }) => email), ['A@example.test', 'z@example.test']);
  assert.deepEqual(db.calls[0].filters, [
    ['eq', 'id', 'list-a'],
    ['eq', 'tenant_id', 'tenant-a'],
  ]);
});

test('preview returns an empty valid list without inventing recipients', async () => {
  const db = database({ audience_list: [{ id: 'empty', tenant_id: 'tenant-a', name: 'Empty' }] });
  const res = response();
  await previewHandler(
    { method: 'POST', body: { listId: 'empty' } },
    res,
    endpointDependencies(db),
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.totalCount, 0);
  assert.deepEqual(res.body.recipients, []);
});

test('preview denies unauthenticated and non-admin requests before database access', async () => {
  for (const [options, expectedStatus] of [
    [{ authenticated: false }, 401],
    [{ admin: false }, 403],
  ]) {
    const db = database();
    const res = response();
    await previewHandler(
      { method: 'POST', body: { listId: 'list-a' } },
      res,
      endpointDependencies(db, options),
    );
    assert.equal(res.statusCode, expectedStatus);
    assert.deepEqual(db.calls, []);
  }
});

test('preview cannot read an audience list belonging to another tenant', async () => {
  const db = database({
    audience_list: [{ id: 'foreign', tenant_id: 'tenant-b', name: 'Foreign' }],
  });
  const res = response();
  await previewHandler(
    { method: 'POST', body: { listId: 'foreign' } },
    res,
    endpointDependencies(db),
  );
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error, 'Audience list not found');
});

const campaignService = await loadCampaignService();

function useServiceFixture(db) {
  globalThis[serviceSlot] = {
    db,
    dependency(name) {
      if (name === 'isActiveCommunicationMember') return true;
      throw new Error(`Unexpected dependency: ${name}`);
    },
  };
}

test('shared audience-list validation accepts valid and empty targeting', async () => {
  const db = database({
    audience_list: [{ id: 'valid', tenant_id: 'tenant-a', target_audiences: [], category_review_required: false }],
  });
  useServiceFixture(db);
  assert.deepEqual(
    await campaignService.validateCampaignAudienceLists(
      { target_audiences: [{ type: 'audience_list', ids: ['valid'] }] },
      'tenant-a',
    ),
    { valid: true },
  );
  assert.deepEqual(await campaignService.validateCampaignAudienceLists({}, 'tenant-a'), { valid: true });
});

test('shared validation rejects a nested review-required list', async () => {
  const db = database({
    audience_list: [
      {
        id: 'parent',
        tenant_id: 'tenant-a',
        category_review_required: false,
        target_audiences: [{ type: 'audience_list', ids: ['child'] }],
      },
      {
        id: 'child',
        tenant_id: 'tenant-a',
        category_review_required: true,
        target_audiences: [],
      },
    ],
  });
  useServiceFixture(db);
  const result = await campaignService.validateCampaignAudienceLists(
    { target_audiences: [{ type: 'audience_list', ids: ['parent'] }] },
    'tenant-a',
  );
  assert.equal(result.valid, false);
  assert.match(result.reason, /Replace every disabled list/);
  assert.equal(db.calls.filter(({ table }) => table === 'audience_list').length, 2);
});

test('shared validation fails closed when review schema is unavailable or list is foreign', async () => {
  for (const [db, expected] of [
    [database({}, { missingReviewSchema: true }), /Unable to validate audience lists.*does not exist/],
    [database({ audience_list: [{ id: 'list-a', tenant_id: 'tenant-b', category_review_required: false }] }), /Replace every disabled list/],
  ]) {
    useServiceFixture(db);
    const result = await campaignService.validateCampaignAudienceLists(
      { target_type: 'audience_list', target_ids: ['list-a'] },
      'tenant-a',
    );
    assert.equal(result.valid, false);
    assert.match(result.reason, expected);
    assert.ok(db.calls[0].filters.some((filter) => filter[1] === 'tenant_id' && filter[2] === 'tenant-a'));
  }
});

test('getTargetRecipients preserves opt-out consent and inherited explicit bypass rules', async () => {
  const baseRows = {
    audience_list: [
      {
        id: 'parent',
        tenant_id: 'tenant-a',
        target_audiences: [{ type: 'audience_list', ids: ['child'] }],
        ignore_opt_outs: false,
        category_review_required: false,
      },
      {
        id: 'child',
        tenant_id: 'tenant-a',
        target_audiences: [],
        ignore_opt_outs: false,
        category_review_required: false,
      },
      {
        id: 'bypass-parent',
        tenant_id: 'tenant-a',
        target_audiences: [{ type: 'audience_list', ids: ['child'] }],
        ignore_opt_outs: true,
        category_review_required: false,
      },
    ],
    audience_list_external_contact: [
      {
        id: 'contact-a',
        tenant_id: 'tenant-a',
        audience_list_id: 'child',
        email: 'opted-out@example.test',
        first_name: 'Opted',
        last_name: 'Out',
      },
      {
        id: 'contact-b',
        tenant_id: 'tenant-b',
        audience_list_id: 'child',
        email: 'foreign@example.test',
      },
    ],
    email_unsubscribe: [
      { tenant_id: 'tenant-a', email: 'OPTED-OUT@example.test', unsubscribe_type: 'all' },
    ],
  };

  const db = database(baseRows);
  useServiceFixture(db);
  const normal = await campaignService.getTargetRecipients(
    { target_audiences: [{ type: 'audience_list', ids: ['parent'] }] },
    'tenant-a',
  );
  assert.equal(normal.success, true);
  assert.deepEqual(normal.recipients, []);

  const bypassDb = database(baseRows);
  useServiceFixture(bypassDb);
  const bypass = await campaignService.getTargetRecipients(
    { target_audiences: [{ type: 'audience_list', ids: ['bypass-parent'] }] },
    'tenant-a',
  );
  assert.equal(bypass.success, true);
  assert.deepEqual(bypass.recipients.map(({ email }) => email), ['opted-out@example.test']);
  assert.equal(bypass.recipients[0].bypass_opt_out, true);
  assert.equal(bypassDb.calls.some(({ table }) => table === 'email_unsubscribe'), false);
});

test('getTargetRecipients fails closed before recipient reads when review schema is missing', async () => {
  const db = database({}, { missingReviewSchema: true });
  useServiceFixture(db);
  const result = await campaignService.getTargetRecipients(
    { target_audiences: [{ type: 'audience_list', ids: ['list-a'] }] },
    'tenant-a',
  );
  assert.equal(result.success, false);
  assert.equal(result.code, 'AUDIENCE_LIST_REPLACEMENT_REQUIRED');
  assert.match(result.error, /does not exist/);
  assert.equal(db.calls.some(({ table }) => table === 'audience_list_external_contact'), false);
});