import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Module from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

globalThis.React = React;
const bundle = await build({
  entryPoints: ['client/src/components/forms/FormRenderer.jsx'],
  bundle: true, write: false, packages: 'external', platform: 'node', format: 'cjs',
  loader: { '.css': 'empty' }, logLevel: 'silent',
});
const compiled = new Module(`${process.cwd()}/payment-summary-test.cjs`);
compiled.filename = `${process.cwd()}/payment-summary-test.cjs`;
compiled.paths = Module._nodeModulePaths(process.cwd());
compiled._compile(bundle.outputFiles[0].text, compiled.filename);
const FormRenderer = compiled.exports.default;
const { QueryClient, QueryClientProvider } = compiled.require('@tanstack/react-query');
const field = { id: 'payment', type: 'payment', label: 'Membership payment', payment_label: 'Payment' };
const quote = { matched: true, quote: { amount: 128, currency: 'GBP',
  membership: { config_name: 'Junior membership', tier_label: 'Flat Rate', membership_year: '2026/2027' } } };
function render(props = {}) {
  const client = new QueryClient();
  try {
    return renderToStaticMarkup(<QueryClientProvider client={client}>
      <FormRenderer field={field} onChange={() => {}} allFields={[field]} membershipFeeQuote={quote} {...props} />
    </QueryClientProvider>);
  } finally { client.clear(); }
}
test('active checkout suppresses the informational summary and its outer label', () => {
  assert.equal(render({ suppressPaymentSummary: true }), '');
});
test('earlier pages retain the amount and membership summary', () => {
  const html = render();
  assert.match(html, /payment-summary-payment/);
  assert.match(html, /128\.00/);
  assert.match(html, /Junior membership/);
});
test('earlier-page loading and error summaries remain available', () => {
  assert.match(render({ membershipFeeQuote: { matched: true, loading: true } }), /Calculating the amount due/);
  assert.match(render({ membershipFeeQuote: { matched: true, error: 'Unable to calculate fee' } }), /Unable to calculate fee/);
});
test('suppression leaves unrelated fields and cart-view behaviour unchanged', () => {
  assert.match(render({ field: { id: 'text', type: 'text', label: 'Your name' }, suppressPaymentSummary: true }), /Your name/);
  assert.match(render({ suppressPaymentSummary: true, allFields: [field, { id: 'cart', type: 'sales_cart_view' }] }),
    /payment-summary-payment/);
});
test('embedded paged and card-swipe renderers suppress only the active field alongside checkout', () => {
  const source = ts.createSourceFile('EmbedForm.jsx', readFileSync('client/src/pages/EmbedForm.jsx', 'utf8'),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX);
  const guards = [];
  function visit(node) {
    if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && node.tagName.getText(source) === 'FormRenderer') {
      const attr = node.attributes.properties.find(a => a.name?.getText(source) === 'suppressPaymentSummary');
      guards.push(attr?.initializer?.expression?.getText(source));
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.deepEqual(guards, [
    'isLastStep && currentField.id === visiblePaymentField?.id',
    'currentPageIndex >= pages.length - 1 && field.id === visiblePaymentField?.id',
  ]);
});
