import test from 'node:test';
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import { build } from 'esbuild';

const bundle = await build({
  entryPoints: ['client/src/components/forms/DepartmentCurrentSetNotice.jsx'],
  bundle: true, write: false, packages: 'external', platform: 'node', format: 'cjs',
  jsx: 'automatic',
});
const compiled = new Module(`${process.cwd()}/department-notice-test.cjs`);
compiled.filename = `${process.cwd()}/department-notice-test.cjs`;
compiled.paths = Module._nodeModulePaths(process.cwd());
compiled._compile(bundle.outputFiles[0].text, compiled.filename);
const require = createRequire(import.meta.url);
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const Notice = compiled.exports.default;
const render = state => renderToStaticMarkup(React.createElement(Notice, { state }));

test('shared department context has no built-in review inputs', () => {
  const html = render({
    active: true, departmentId: 'department',
    displayIdentity: { department: { label: 'Nuclear Medicine' } },
    currentSet: { workforce: {}, equipment: {} },
  });
  assert.match(html, /Nuclear Medicine/);
  assert.doesNotMatch(html, /I have reviewed|acknowledge-current|checkbox|radio/);
});
test('selection, loading and failure messages remain available without review controls', () => {
  assert.match(render({ active: true, departmentOptions: [{ id: 'department', label: 'Nuclear Medicine' }] }),
    /Choose the Department to update/);
  assert.match(render({ active: true, loading: true }), /Loading current Department data/);
  assert.match(render({ active: true, error: { message: 'Unavailable' } }), /Unavailable/);
});
