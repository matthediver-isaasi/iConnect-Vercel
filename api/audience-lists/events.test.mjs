import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import Module from 'node:module';

const compiled = await build({
  entryPoints: ['api/audience-lists/events.js'],
  bundle: true, write: false, platform: 'node', format: 'cjs',
  plugins: [{
    name: 'isolated-event-discovery',
    setup(builder) {
      builder.onResolve({ filter: /\/_lib\/(tenantContext|database)\.js$/ }, args => ({ path: args.path, namespace: 'mock' }));
      builder.onLoad({ filter: /.*/, namespace: 'mock' }, args => ({
        contents: args.path.includes('tenantContext')
          ? `export const getTenantContext = async () => ({tenantId:'tenant-a'}); export const hasAdminAccess = async () => true;`
          : `export const supabase = { from: table => globalThis.__eventDiscoveryQuery(table) };`,
      }));
    },
  }],
});
const module = new Module('event-discovery-test');
module._compile(compiled.outputFiles[0].text, 'event-discovery-test.cjs');

for (const waitingListOnly of [false, true]) {
  test(`event discovery ${waitingListOnly ? 'filters both event types to waiting lists' : 'preserves all attendee events'}`, async () => {
    const calls = [];
    globalThis.__eventDiscoveryQuery = table => {
      const filters = [];
      calls.push({ table, filters });
      const query = {
        select() { return this; }, order() { return this; }, limit() { return this; },
        eq(...args) { filters.push(args); return this; },
        then(resolve) {
          const rows = [
            { id: `${table}-enabled`, title: 'Enabled', waiting_list_enabled: true },
            { id: `${table}-disabled`, title: 'Disabled', waiting_list_enabled: false },
          ];
          return Promise.resolve({ data: rows.filter(row => !filters.some(([key, value]) => key === 'waiting_list_enabled' && row[key] !== value)), error: null }).then(resolve);
        },
      };
      return query;
    };
    let result;
    await module.exports.default(
      { method: 'GET', query: waitingListOnly ? { waiting_list_only: 'true' } : {} },
      { json(value) { result = value; }, status(code) { throw new Error(`Unexpected status ${code}`); } },
    );
    assert.equal(result.length, waitingListOnly ? 2 : 4);
    assert.deepEqual(calls.map(c => c.table), ['event', 'complex_event']);
    for (const { filters } of calls) {
      assert.deepEqual(filters, [['tenant_id', 'tenant-a'], ...(waitingListOnly ? [['waiting_list_enabled', true]] : [])]);
    }
    if (waitingListOnly) assert.ok(result.every(row => row.id.endsWith('-enabled')));
    delete globalThis.__eventDiscoveryQuery;
  });
}
