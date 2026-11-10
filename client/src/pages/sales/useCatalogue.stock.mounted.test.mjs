import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/sales/catalogue' });
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node']) {
  Object.defineProperty(globalThis, name, { value: name === 'window' ? dom.window : dom.window[name], configurable: true, writable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
after(() => dom.window.close());
const result = await build({
  stdin: { contents: 'export {useCatalogue} from "./client/src/pages/sales/useCatalogue.js"; export {requests} from "@/api/base44Client";', resolveDir: process.cwd() },
  bundle: true, write: false, packages: 'external', platform: 'node', format: 'cjs',
  plugins: [{ name: 'catalogue-network-fixture', setup(builder) {
    builder.onResolve({ filter: /^@\// }, args => ({ path: args.path, namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path.includes('base44Client') ? `
      export const requests = [];
      export const base44 = {_apiRequest: async (path, options) => {
        requests.push({path, options});
        if (options) return {remaining: 9, reserved: 3, version: 8};
        return {items: [{id: "stock-item", productStock: {remaining: 4, reserved: 3, version: 7}, bundleStock: {remaining: 4, reserved: 3, version: 7}}]};
      }};
    ` : 'export const useSalesSettingsScope = () => ({scopeKey: "test-tenant", ready: true});' }));
  } }],
});
const mod = new Module(`${process.cwd()}/catalogue-stock-test.cjs`);
mod.filename = `${process.cwd()}/catalogue-stock-test.cjs`;
mod.paths = Module._nodeModulePaths(process.cwd());
mod._compile(result.outputFiles[0].text, mod.filename);
const { useCatalogue, requests } = mod.exports;
const require = createRequire(import.meta.url);
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const { QueryClient, QueryClientProvider } = require('@tanstack/react-query');

for (const resource of ['products', 'bundles']) {
  test(`${resource} stock uses PATCH and patches only its stock cache`, async () => {
    const client = new QueryClient({ defaultOptions: { queries: { gcTime: 0 }, mutations: { gcTime: 0 } } });
    const container = document.createElement('div');
    const root = createRoot(container);
    requests.length = 0;
    let catalogue;
    function Fixture() { catalogue = useCatalogue(resource); return null; }
    try {
      await act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(Fixture))));
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); });
      await act(async () => catalogue.updateStock.mutateAsync({ id: 'stock-item', remaining: 9, expectedVersion: 7 }));
      const request = requests.find(entry => entry.options);
      assert.equal(request.path, `/api/sales/catalogue/${resource}/stock-item/stock`);
      assert.equal(request.options.method, 'PATCH');
      assert.deepEqual(JSON.parse(request.options.body), { remaining: 9, expectedVersion: 7 });
      const row = client.getQueryData(['sales-catalogue', resource, 'test-tenant', '']).items[0];
      assert.deepEqual(row[resource === 'products' ? 'productStock' : 'bundleStock'], { remaining: 9, reserved: 3, version: 8 });
      assert.equal(row[resource === 'products' ? 'bundleStock' : 'productStock'].version, 7);
    } finally { await act(async () => root.unmount()); client.clear(); }
  });
}
