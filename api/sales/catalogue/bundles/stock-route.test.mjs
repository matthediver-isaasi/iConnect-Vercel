import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('deployed stock entry delegates to the protected catalogue handler', async () => {
  const source = await readFile(new URL('./[id]/stock.js', import.meta.url), 'utf8');
  assert.match(source, /import \{ createSalesCatalogueHandler \} from '\.\.\/\.\.\/\[\.\.\.path\]\.js'/);
  let forwarded;
  const context = vm.createContext({
    createSalesCatalogueHandler: () => (req, res) => {
      forwarded = { req, res };
      return 'handled';
    },
  });
  vm.runInContext(source.replace(/^import .*;\n/m, '').replace('export default', 'globalThis.route ='), context);
  for (const remaining of [1, 0, null]) {
    const req = {
      method: 'PATCH',
      query: { id: 'bundle-id', path: ['products', 'other', 'archive'] },
      body: { remaining, expectedVersion: 7 },
    };
    const res = {};
    assert.equal(context.route(req, res), 'handled');
    assert.equal(forwarded.req, req);
    assert.equal(forwarded.res, res);
    assert.deepEqual(Array.from(req.query.path), ['bundles', 'bundle-id', 'stock']);
    assert.deepEqual(req.body, { remaining, expectedVersion: 7 });
    assert.equal(req.method, 'PATCH');
  }
});
