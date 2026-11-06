import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

// Mount the real designer with fixture-owned I/O. No server, database or API
// provider is contacted; only PDF rendering, access, viewport and UI shells
// are stubbed. The separate browser spec exercises the real styled components.
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/CPDCertificateTemplates/fixture', pretendToBeVisual: true,
});
const { window } = dom;
for (const key of ['document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement',
  'Element', 'Node', 'Event', 'MouseEvent']) {
  Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true });
}
globalThis.window = window;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.confirm = () => true;
const source = (await readFile('client/src/pages/CPDCertificateTemplates.jsx', 'utf8'))
  .replace(/pdfjs\.GlobalWorkerOptions\.workerSrc = .*?;\n/, '');
const ui = `
  import React from 'react';
  export const Button = ({variant, size, children, ...props}) => React.createElement('button', props, children);
  export const Input = React.forwardRef((props, ref) => React.createElement('input', {...props, ref}));
  export const Label = props => React.createElement('label', props);
  export const Card = props => React.createElement('div', props);
  export const CardContent = Card, CardHeader = Card, CardTitle = Card, Badge = Card;
  export const Switch = ({checked, onCheckedChange}) => React.createElement('input', {
    type: 'checkbox', checked, onChange: e => onCheckedChange(e.target.checked) });
`;
const stubs = {
  ui,
  query: `
    import { useState, useEffect } from 'react';
    export function useQuery({queryKey, queryFn}) {
      const [state, setState] = useState({isLoading: true});
      const key = JSON.stringify(queryKey);
      useEffect(() => { let cancelled = false;
        queryFn().then(data => { if (!cancelled) setState({data, isLoading: false}); })
          .catch(error => { if (!cancelled) setState({error, isLoading: false}); });
        return () => { cancelled = true; };
      }, [key]);
      return state;
    }
    export const useQueryClient = () => ({invalidateQueries() {}});
  `,
  router: `export const useNavigate = () => () => {}; export const useParams = () => ({});`,
  viewport: `export const useCertificateViewport = () => ({scale: 1, height: 800});`,
  access: `export const useMemberAccess = () => ({});`,
  pdf: `export const GlobalWorkerOptions = {};`,
  toast: `export const toast = {success() {}, error() {}, warning() {}};`,
};
const bundle = await build({
  stdin: { contents: source, loader: 'jsx', resolveDir: `${process.cwd()}/client/src/pages` },
  bundle: true, write: false, packages: 'external', platform: 'node', format: 'cjs', logLevel: 'silent',
  plugins: [{
    name: 'fixture-modules',
    setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => {
        if (args.path === 'react') return { path: 'react', external: true };
        const name = args.path.startsWith('@/components/ui/') ? 'ui' :
          args.path === '@tanstack/react-query' ? 'query' :
            args.path === 'react-router-dom' ? 'router' :
              args.path === '@/hooks/useCertificateViewport' ? 'viewport' :
                args.path === '@/hooks/useMemberAccess' ? 'access' :
                  args.path === 'pdfjs-dist' ? 'pdf' : args.path === 'sonner' ? 'toast' : null;
        if (name) return { path: name, namespace: 'fixture' };
        if (args.path.startsWith('@/lib/')) return { path: `${process.cwd()}/client/src/lib/${args.path.slice(6)}.js` };
      });
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: stubs[args.path], loader: 'js' }));
    },
  }],
});
const mod = new Module(`${process.cwd()}/certificate-signatures-test.cjs`);
mod.filename = `${process.cwd()}/certificate-signatures-test.cjs`;
mod.paths = Module._nodeModulePaths(process.cwd());
mod._compile(bundle.outputFiles[0].text, mod.filename);
const { TemplateDesigner } = mod.exports;
const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
after(() => dom.window.close());
const wait = () => new Promise(resolve => setTimeout(resolve, 5));
const ASSET = { id: '12345678-1234-4234-8234-123456789abc', sha256: 'a'.repeat(64),
  mime_type: 'image/png', width: 900, height: 300 };
const image = { placeholder_key: 'signature.fixture', label: 'Signature', field_type: 'image',
  image_asset_id: ASSET.id, image_sha256: ASSET.sha256, page_number: 1,
  x: 72, y: 72, width: 180, height: 60 };
const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; });

async function mount(t, { active = false, existing = false, dropImage = false } = {}) {
  const state = { uploads: [], saves: [], failUpload: false };
  const template = { id: 'fixture', name: 'Signature fixture', status: active ? 'active' : 'draft', version: 4,
    placeholders: existing ? [image] : [], pdf_metadata: { pages: [{ width: 612, height: 792 }, { width: 792, height: 612 }] } };
  globalThis.fetch = async (url, options = {}) => {
    assert.equal(options.credentials, 'include');
    const respond = (body, ok = true) => ({ ok, status: ok ? 200 : 503, json: async () => body });
    if (url === '/api/cpd-certificate-templates') return respond({ templates: [] });
    if (url.endsWith('/source')) return respond({ signedUrl: '' });
    if (url.endsWith('/signatures') && options.method === 'POST') {
      state.uploads.push(options.body);
      if (state.failUpload) return respond({ error: 'Signature upload failed' }, false);
      return respond({ asset: ASSET, previewUrl: `/api/cpd-certificate-templates/fixture/signatures?assetId=${ASSET.id}` });
    }
    assert.equal(url, '/api/cpd-certificate-templates/fixture', 'unexpected API request');
    if (options.method === 'PUT') {
      const body = JSON.parse(options.body); state.saves.push(body);
      template.version++;
      template.placeholders = body.placeholders;
      return respond({ template: { ...template, placeholders: body.placeholders.map(field =>
        dropImage ? { ...field, image_sha256: null } : field) } });
    }
    return respond({ template });
  };
  let root;
  const render = async () => {
    const container = document.createElement('div'); document.body.append(container);
    root = createRoot(container);
    await act(async () => { root.render(React.createElement(TemplateDesigner, { id: 'fixture' })); await wait(); });
    return container;
  };
  let container = await render();
  state.reload = async () => {
    await act(async () => { root.unmount(); });
    container.remove();
    container = await render();
  };
  t.after(async () => { await act(async () => { root.unmount(); }); container.remove(); });
  return state;
}
const byLabel = name => document.querySelector(`[aria-label="${name}"]`);
const button = name => [...document.querySelectorAll('button')].find(el => el.textContent.trim() === name);
const signatures = () => document.querySelectorAll('[data-testid="certificate-signature"]');
async function click(el) {
  assert.ok(el, 'expected clickable element');
  await act(async () => { el.click(); await wait(); });
}
async function pointer(el, type, x, y) {
  await act(async () => { el.dispatchEvent(new window.MouseEvent(type, { bubbles: true, clientX: x, clientY: y })); await wait(); });
}
async function upload(el, file = new File(['signature'], 'chair.png', { type: 'image/png' })) {
  assert.ok(el);
  Object.defineProperty(el, 'files', { configurable: true, value: [file] });
  await act(async () => { el.dispatchEvent(new window.Event('change', { bubbles: true })); await wait(); });
}
async function setValue(id, value, select = false) {
  const el = document.getElementById(id);
  assert.ok(el, id);
  const prototype = select ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(el, value);
    el.dispatchEvent(new window.Event(select ? 'change' : 'input', { bubbles: true }));
    await wait();
  });
}

test('real designer signature upload, numeric and pointer resize/move, page selection, duplicate, checked save and reload', async t => {
  const state = await mount(t);
  await upload(byLabel('Upload signature image'));
  assert.equal(signatures().length, 1);
  assert.equal(state.uploads[0].get('expectedVersion'), '4');
  assert.equal(state.uploads[0].get('file').name, 'chair.png');
  assert.ok(!document.body.textContent.includes('Sample / preview value'));
  assert.ok(!document.body.textContent.includes('Font family'));
  assert.ok(!document.body.textContent.includes('field(s) have no sample'));
  await setValue('signature-width', '240');
  assert.equal(document.getElementById('signature-height').value, '80');
  await setValue('signature-height', '60');
  assert.equal(document.getElementById('signature-width').value, '180');
  await pointer(signatures()[0], 'pointerdown', 100, 100);
  await pointer(window, 'pointermove', 120, 130);
  await pointer(window, 'pointerup', 120, 130);
  assert.equal(document.getElementById('signature-x').value, '92');
  assert.equal(document.getElementById('signature-y').value, '102');
  await pointer(byLabel('Resize field'), 'pointerdown', 200, 200);
  await pointer(window, 'pointermove', 260, 200);
  await pointer(window, 'pointerup', 260, 200);
  assert.equal(document.getElementById('signature-width').value, '240');
  assert.equal(document.getElementById('signature-height').value, '80');
  await setValue('signature-page', '2', true);
  assert.equal(document.getElementById('certificate-page-select').value, '2');
  await click(button('Duplicate'));
  assert.equal(signatures().length, 2);
  await click(button('Save'));
  assert.equal(state.saves[0].expectedVersion, 4);
  assert.equal(state.saves[0].placeholders.length, 2);
  assert.ok(state.saves[0].placeholders.every(field => field.image_asset_id === ASSET.id && field.page_number === 2));
  assert.ok(button('Save').disabled);
  await state.reload();
  await setValue('certificate-page-select', '2', true);
  assert.equal(signatures().length, 2);
  assert.equal(signatures()[0].querySelector('img').getAttribute('src'),
    `/api/cpd-certificate-templates/fixture/signatures?assetId=${ASSET.id}`);
  await pointer(signatures()[0], 'pointerdown', 10, 10);
  await pointer(window, 'pointerup', 10, 10);
  await click(button('Remove signature'));
  assert.equal(signatures().length, 1);
  await click(button('Save'));
  assert.equal(state.saves.at(-1).placeholders.length, 1);
});

test('invalid files and upload errors leave existing signature intact, and replacement can be retried', async t => {
  const state = await mount(t, { existing: true });
  await upload(byLabel('Upload signature image'), new File(['svg'], 'chair.svg', { type: 'image/svg+xml' }));
  assert.match(document.querySelector('[role="alert"]').textContent, /JPG, JPEG or PNG/);
  assert.equal(state.uploads.length, 0);
  await pointer(signatures()[0], 'pointerdown', 100, 100);
  await pointer(window, 'pointerup', 100, 100);
  state.failUpload = true;
  await upload(byLabel('Replace signature image'));
  assert.match(document.querySelector('[role="alert"]').textContent, /Signature upload failed/);
  assert.equal(signatures().length, 1);
  assert.ok(button('Save').disabled);
  state.failUpload = false;
  await upload(byLabel('Replace signature image'));
  assert.equal(document.querySelector('[role="alert"]'), null);
  assert.equal(signatures().length, 1);
  assert.equal(state.uploads.length, 2);
});

test('a save response dropping signature identity keeps the unsaved draft', async t => {
  const state = await mount(t, { dropImage: true });
  await upload(byLabel('Upload signature image'));
  await click(button('Save'));
  assert.equal(state.saves.length, 1);
  assert.match(document.querySelector('[role="alert"]').textContent, /signature identity and geometry/);
  assert.match(document.body.textContent, /Unsaved/);
  assert.ok(!button('Save').disabled);
  assert.equal(signatures().length, 1);
});

test('active templates show signatures but no upload/replace/remove/duplicate/resize/save controls', async t => {
  const state = await mount(t, { active: true, existing: true });
  assert.equal(signatures().length, 1);
  await pointer(signatures()[0], 'pointerdown', 100, 100);
  await pointer(window, 'pointermove', 120, 120);
  await pointer(window, 'pointerup', 120, 120);
  assert.equal(byLabel('Upload signature image'), null);
  assert.equal(byLabel('Replace signature image'), null);
  assert.equal(byLabel('Resize field'), null);
  for (const name of ['Save', 'Duplicate', 'Remove signature']) assert.equal(button(name), undefined);
  assert.equal(state.uploads.length, 0);
  assert.equal(state.saves.length, 0);
  assert.equal(signatures()[0].style.left, '72px');
});
