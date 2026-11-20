import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import Module, { createRequire } from 'node:module';
import { build } from 'esbuild';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/forms/auto' });
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document,
  localStorage: dom.window.localStorage, sessionStorage: dom.window.sessionStorage,
  location: dom.window.location, history: dom.window.history, HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element, Node: dom.window.Node, Event: dom.window.Event,
  DocumentFragment: dom.window.DocumentFragment, MutationObserver: dom.window.MutationObserver,
  getComputedStyle: dom.window.getComputedStyle, IS_REACT_ACT_ENVIRONMENT: true,
});
const React = (await import('react')).default;
globalThis.React = React;
const { act, useEffect, useState } = React;
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = createRequire(import.meta.url)('@tanstack/react-query');
const bundle = await build({
  entryPoints: ['client/src/components/forms/FormRenderer.jsx'],
  bundle: true, write: false, packages: 'external', platform: 'node', format: 'cjs',
  loader: { '.css': 'empty' }, logLevel: 'silent',
});
const bundledModule = new Module(`${process.cwd()}/auto-fields-test.cjs`);
bundledModule.filename = `${process.cwd()}/auto-fields-test.cjs`;
bundledModule.paths = Module._nodeModulePaths(process.cwd());
bundledModule._compile(bundle.outputFiles[0].text, bundledModule.filename);
const FormRenderer = bundledModule.exports.default;
const member = { id: 'member-a', first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.invalid', job_title: 'Engineer' };
const organization = { id: 'org-a', name: 'Example Organisation' };

for (const [type, expected] of [
  ['user_name', 'Ada Lovelace'],
  ['user_email', 'ada@example.invalid'],
  ['user_organization', 'Example Organisation'],
  ['user_job_title', 'Engineer'],
]) {
  test(`${type} survives the parent form initialization reset and preserves saved answers`, async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    let changes = 0;
    function Form({ saved }) {
      const [values, setValues] = useState({});
      // The real standalone, Canvas and iframe forms reset values after loading
      // their definition. Child effects run first, so this can erase auto values.
      useEffect(() => { setValues(saved ? { auto: saved } : {}); }, [saved]);
      return <FormRenderer field={{ id: 'auto', type, label: 'Automatic', locked: true }}
        value={values.auto} memberInfo={member} organizationInfo={organization}
        onChange={value => { changes++; setValues(previous => ({ ...previous, auto: value })); }} />;
    }
    try {
      await act(async () => root.render(<QueryClientProvider client={client}><Form /></QueryClientProvider>));
      assert.equal(container.querySelector('input').value, expected);
      assert.equal(container.querySelector('input').readOnly, true);
      assert.ok(changes <= 3, 'population must converge, not loop');
      await act(async () => root.render(<QueryClientProvider client={client}><Form saved="Saved answer" /></QueryClientProvider>));
      assert.equal(container.querySelector('input').value, 'Saved answer');
    } finally {
      await act(async () => root.unmount());
      client.clear();
      container.remove();
    }
  });
}
