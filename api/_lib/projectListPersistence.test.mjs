import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import Module from 'node:module';
import { isListColor, listAppearance } from '../../shared/projectListAppearance.mjs';

let role, guard, rpcError, rpcCalls, patch;
globalThis.__listDb = {
  rpc: async () => { rpcCalls++; return { data: [], error: rpcError }; },
  from(table) {
    const q = {
      select() { return q; }, eq() { return q; }, single() { return q; },
      update(value) { patch = value; return q; },
      then(resolve) { return Promise.resolve({ data: table === 'project_board_member' ? { role }
        : { board_id: 'board', ...patch }, error: null }).then(resolve); },
    };
    return q;
  },
};
globalThis.__listGuard = (req, res) => {
  if (!guard) res.status(403).json({ error: 'Linked board denied' });
  return guard;
};
async function load(file) {
  const out = await build({ entryPoints: [file], bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external',
    plugins: [{ name: 'isolated', setup(b) {
      b.onLoad({ filter: /\/_lib\/database\.js$/ }, () => ({ contents: 'export const supabase=globalThis.__listDb;' }));
      b.onLoad({ filter: /\/_lib\/session\.js$/ }, () => ({ contents: 'export const getSession=async()=>({data:{identityId:"actor",tenantId:"tenant"}});' }));
      b.onLoad({ filter: /\/_lib\/salesLinkedProjectGuard\.js$/ }, () => ({ contents: 'export const guardSalesLinkedProject=globalThis.__listGuard;' }));
    } }] });
  const mod = new Module(`${process.cwd()}/list-tests.cjs`);
  mod.filename = `${process.cwd()}/list-tests.cjs`;
  mod.paths = Module._nodeModulePaths(process.cwd());
  mod._compile(out.outputFiles[0].text, mod.filename);
  return mod.exports.default;
}
const reorder = await load('api/projects/boards/[boardId]/lists.js');
const update = await load('api/projects/lists/[listId].js');
async function request(handler, body) {
  const res = { statusCode: 200, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
  await handler({ method: 'PATCH', headers: {}, query: { boardId: 'board', listId: 'list' }, body }, res);
  return res;
}
test('API denies viewer and linked-board writes; validates colours and reset', async () => {
  role = 'member'; guard = true;
  for (const color of ['#123abc', '#ABCDEF', null]) {
    assert.equal((await request(update, { color })).statusCode, 200);
    assert.equal(patch.color, color);
  }
  for (const color of ['', '#abc', 'red', {}, '#12345678']) {
    assert.equal((await request(update, { color })).statusCode, 400);
  }
  role = 'viewer';
  assert.equal((await request(update, { color: null })).statusCode, 403);
  assert.equal((await request(reorder, { lists: [] })).statusCode, 403);
  role = 'member'; guard = false;
  assert.equal((await request(update, { color: null })).statusCode, 403);
  assert.equal((await request(reorder, { lists: [] })).statusCode, 403);
});
test('API checks reorder errors and rejects malformed and duplicate IDs before writes', async () => {
  role = 'member'; guard = true; rpcCalls = 0;
  const id = '00000000-0000-0000-0000-000000000001';
  for (const lists of [null, [null], [{ id: 'bad' }], [{ id }, { id }]]) {
    assert.equal((await request(reorder, { lists })).statusCode, 400);
  }
  assert.equal(rpcCalls, 0);
  for (const [code, status] of [['PT409', 409], ['42501', 403], ['XX000', 500]]) {
    rpcError = { code };
    assert.equal((await request(reorder, { lists: [{ id }] })).statusCode, status);
  }
  rpcError = null;
  assert.equal((await request(reorder, { lists: [{ id }] })).statusCode, 200);
});
test('colour contrast chooses black or white; legacy invalid values stay neutral', () => {
  assert.equal(isListColor(null), true);
  assert.deepEqual(listAppearance('red'), {});
  assert.equal(listAppearance('#ffffff').color, '#000000');
  assert.equal(listAppearance('#334155').color, '#ffffff');
});
