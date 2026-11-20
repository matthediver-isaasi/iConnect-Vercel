import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { build } from 'esbuild';

// Execute the real handler against an in-memory, filtering query adapter.
// No database or provider access.
const result = await build({
  entryPoints: ['api/public/system-settings.js'],
  bundle: true, write: false, packages: 'external', platform: 'node', format: 'cjs',
  define: {
    'process.env.SUPABASE_URL': '"https://fixture.invalid"',
    'process.env.SUPABASE_SERVICE_KEY': '"fixture-only"',
  },
  plugins: [{
    name: 'public-settings-boundaries',
    setup(builder) {
      builder.onResolve({ filter: /^@supabase\/supabase-js$/ }, () => ({ path: 'db', namespace: 'fixture' }));
      builder.onResolve({ filter: /tenantResolver\.js$/ }, () => ({ path: 'tenant', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({
        contents: path === 'db' ? 'export const createClient = () => globalThis.__publicSettingsDb;'
          : 'export const resolveTenantFromRequest = async req => req.query.tenant === "unknown" ? null : ({id:req.query.tenant});',
      }));
    },
  }],
});
const compiled = new Module(`${process.cwd()}/public-settings-test.cjs`);
compiled.filename = `${process.cwd()}/public-settings-test.cjs`;
compiled.paths = Module._nodeModulePaths(process.cwd());
compiled._compile(result.outputFiles[0].text, compiled.filename);
const handler = compiled.exports.default;

async function request(query = {}, { fail = false } = {}) {
  const rows = [
    { id: 'a-terms', tenant_id: 'tenant-a', setting_key: 'job_posting_terms', setting_value: '{"title":"Tenant A terms","content":"A only"}' },
    { id: 'b-terms', tenant_id: 'tenant-b', setting_key: 'job_posting_terms', setting_value: '{"title":"Tenant B terms","content":"B only"}' },
    { id: 'a-private', tenant_id: 'tenant-a', setting_key: 'private_credentials', setting_value: 'must-not-be-public' },
    { id: 'a-price', tenant_id: 'tenant-a', setting_key: 'job_posting_price', setting_value: '80' },
  ];
  let filtered = rows;
  globalThis.__publicSettingsDb = {
    from(table) {
      assert.equal(table, 'system_settings');
      const builder = {
        select(columns) { assert.equal(columns, 'id, setting_key, setting_value'); return this; },
        eq(key, value) { filtered = filtered.filter(row => row[key] === value); return this; },
        in(key, values) { filtered = filtered.filter(row => values.includes(row[key])); return this; },
        then(resolve, reject) {
          return Promise.resolve({
            data: filtered.map(({ tenant_id, ...row }) => row),
            error: fail ? { message: 'fixture failure' } : null,
          }).then(resolve, reject);
        },
      };
      return builder;
    },
  };
  const response = { setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  try { await handler({ method: 'GET', query }, response); }
  finally { delete globalThis.__publicSettingsDb; }
  return response;
}

test('public job terms are tenant-scoped in list and keyed requests; private settings stay private', async () => {
  for (const tenant of ['tenant-a', 'tenant-b']) {
    const listed = await request({ tenant });
    assert.equal(listed.code, 200);
    assert.equal(listed.body.find(row => row.setting_key === 'job_posting_terms')?.id, tenant === 'tenant-a' ? 'a-terms' : 'b-terms');
    assert.equal(listed.body.some(row => row.setting_key === 'private_credentials'), false);
    const keyed = await request({ tenant, key: 'job_posting_terms' });
    assert.deepEqual(keyed.body, listed.body.filter(row => row.setting_key === 'job_posting_terms'));
  }
  assert.equal((await request({ tenant: 'tenant-a', key: 'private_credentials' })).code, 403);
  assert.equal((await request({ tenant: 'unknown' })).code, 404);
});

test('public query failures are explicit errors, never successful empty settings', async () => {
  const response = await request({ tenant: 'tenant-a' }, { fail: true });
  assert.equal(response.code, 500);
  assert.deepEqual(response.body, { error: 'Failed to fetch settings' });
});
