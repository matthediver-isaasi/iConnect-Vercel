import test from 'node:test';
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';
const { QueryClient, QueryClientProvider } = createRequire(import.meta.url)('@tanstack/react-query');

globalThis.React = React;
test('standalone and embedded forms wire the count to live answers in both layouts', async () => {
  for (const path of [
    'client/src/pages/FormView.jsx',
    'client/src/pages/EmbedForm.jsx',
    'client/src/components/iedit/elements/IEditFormElement.jsx',
  ]) {
    const source = await readFile(path, 'utf8');
    assert((source.match(/<FormCartCount form=\{form\} values=\{formValues\}/g) || []).length >= 2, path);
    await transform(source, { loader: 'jsx' });
  }
});
const built = await build({ entryPoints: ['client/src/components/forms/FormCartCount.jsx'], bundle: true,
  packages: 'external', platform: 'node', format: 'cjs', write: false });
const mod = new Module(`${process.cwd()}/cart-count-test.cjs`);
mod.paths = Module._nodeModulePaths(process.cwd());
mod._compile(built.outputFiles[0].text, mod.id);
const form = { id: 'count-form', fields: [{ id: 'cart', type: 'sales_cart' }] };
const id = '12345678-1234-4234-8234-123456789012';
const render = (values, definition = form, busy = false) => {
  const client = new QueryClient();
  client.setQueryData(['form-cart-pending', definition.id], busy);
  const html = renderToStaticMarkup(React.createElement(QueryClientProvider, { client },
    React.createElement(mod.exports.default, { form: definition, values })));
  client.clear();
  return html;
};
test('pill shows pending feedback without inflating the confirmed quantity', () => {
  const html = render({}, form, true);
  assert.match(html, /Updating cart. 0 items in cart/);
  assert.match(html, /animate-spin/);
  assert.doesNotMatch(render({}, form), /animate-spin/);
});
test('cart pill is absent without a cart and counts total units across both item types', () => {
  assert.equal(render({}, { fields: [] }), '');
  assert.match(render({}), /0 items in cart/);
  assert.match(render({ cart: { version: 1, lines: [{ kind: 'product', id, quantity: 1 }] } }), /1 item in cart/);
  assert.match(render({ cart: { version: 1, lines: [
    { kind: 'product', id, quantity: 2 }, { kind: 'bundle', id, quantity: 3 },
  ] } }), /5 items in cart/);
  assert.match(render({ cart: { version: 1, lines: [] } }), /0 items in cart/);
  assert.match(render({ cart: { broken: true } }), /Cart needs attention/);
});
