import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Execute the production loader without importing the full canvas registry.
const source = fs.readFileSync(new URL('../components/canvas/blocks/registry.jsx', import.meta.url), 'utf8');
const loader = source.slice(source.indexOf('async function fetchTenantTypographyStyles('),
  source.indexOf('// Typography styles injected'));

async function run({ authoring = false, prefix = null, privateFailure = false, publicFailure = false } = {}) {
  const calls = [];
  const context = vm.createContext({
    encodeURIComponent,
    base44: { entities: { TypographyStyle: { list: async () => {
      calls.push('private');
      if (privateFailure) throw new Error('Not authenticated');
      return [{ id: 'editor' }, { id: 'inactive', is_active: false }];
    } } } },
    fetch: async url => {
      calls.push(url);
      return { ok: !publicFailure, json: async () => [{ id: 'published' }] };
    },
  });
  vm.runInContext(loader.replace("const { base44 } = await import('@/api/base44Client');", '') +
    '\nglobalThis.load = fetchTenantTypographyStyles;', context);
  const result = await context.load(prefix, authoring);
  return { calls, ids: Array.from(result, row => row.id) };
}

test('cold public visits never probe the protected entity endpoint', async () => {
  assert.deepEqual(await run(), {
    calls: ['/api/public/typography-styles'], ids: ['published'],
  });
});
test('public microsite discovery preserves its scope', async () => {
  assert.deepEqual(await run({ prefix: 'patients & carers' }), {
    calls: ['/api/public/typography-styles?microsite=patients%20%26%20carers'], ids: ['published'],
  });
});
test('authoring keeps authenticated, unscoped active styles', async () => {
  assert.deepEqual(await run({ authoring: true }), { calls: ['private'], ids: ['editor'] });
});
test('authoring can still fall back to the public endpoint', async () => {
  assert.deepEqual(await run({ authoring: true, privateFailure: true }), {
    calls: ['private', '/api/public/typography-styles'], ids: ['published'],
  });
});
test('failed public discovery settles rather than leaving text hidden indefinitely', async () => {
  assert.deepEqual(await run({ publicFailure: true }), {
    calls: ['/api/public/typography-styles'], ids: [],
  });
});
test('authoring cache is separate and requires explicit editor context', () => {
  assert.match(source, /const authoring = isEditor === true \|\| editorPreview === true/);
  assert.match(source, /\['\/api\/public\/typography-styles', micrositePrefix, 'authoring'\]/);
  const builder = fs.readFileSync(new URL('../components/canvas/CanvasBuilder.jsx', import.meta.url), 'utf8');
  assert.match(builder, /<CanvasEditorPageProvider micrositeId=\{micrositeId\} isEditor>/);
});
