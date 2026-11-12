import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

globalThis.React = React;
const built = await build({ entryPoints: ['client/src/components/forms/FormCartCount.jsx'], bundle: true,
  packages: 'external', platform: 'node', format: 'cjs', write: false });
const mod = new Module(`${process.cwd()}/cart-count-test.cjs`);
mod.paths = Module._nodeModulePaths(process.cwd());
mod._compile(built.outputFiles[0].text, mod.id);
const form = { fields: [{ id: 'cart', type: 'sales_cart' }] };
const id = '12345678-1234-4234-8234-123456789012';
const render = (values, definition = form) => renderToStaticMarkup(React.createElement(mod.exports.default, { form: definition, values }));
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
