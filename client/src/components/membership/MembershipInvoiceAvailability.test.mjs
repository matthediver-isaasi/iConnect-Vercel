import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import Module, { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const result = await build({
  entryPoints: ['client/src/components/membership/MembershipInvoiceAvailability.jsx'],
  bundle: true, write: false, platform: 'node', format: 'cjs',
  packages: 'external', jsx: 'automatic',
});
const compiled = new Module(path.resolve('invoice-status-test.cjs'));
compiled.filename = path.resolve('invoice-status-test.cjs');
compiled.paths = Module._nodeModulePaths(process.cwd());
compiled._compile(result.outputFiles[0].text, compiled.filename);
const Component = compiled.exports.default;
test('renders explicit invoice states rather than an empty column', () => {
  for (const [status, label] of Object.entries({
    missing: 'No invoice linked', pending: 'Invoice pending', blocked: 'Invoice blocked',
    unavailable: 'Status unavailable', not_required: 'No invoice required',
  })) {
    const html = renderToStaticMarkup(React.createElement(Component, { record: {
      id: 'record', invoice_availability: { status, message: 'Explanation' },
    } }));
    assert.ok(html.includes(label));
    assert.ok(html.includes('Explanation'));
  }
});
test('an older API response is reported as unavailable rather than missing', () => {
  const html = renderToStaticMarkup(React.createElement(Component, { record: { id: 'record' } }));
  assert.ok(html.includes('Status unavailable'));
});
