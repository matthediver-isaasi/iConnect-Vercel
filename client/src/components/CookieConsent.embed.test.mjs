import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import Module from 'node:module';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://example.test/' });
for (const key of ['window', 'document', 'navigator', 'location', 'history', 'HTMLElement', 'Element', 'Node']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? dom.window : dom.window[key] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const originalFetch = globalThis.fetch;
const result = await build({
  entryPoints: ['client/src/components/CookieConsent.jsx'],
  bundle: true, write: false, packages: 'external', platform: 'node', format: 'cjs', jsx: 'automatic',
  plugins: [{
    name: 'consent-fixtures',
    setup(build) {
      build.onResolve({ filter: /^@cookieyes\/|TenantBrandingContext$|resetConsentRuntime\.js$|consentTracking\.js$/ }, args => ({ path: args.path, namespace: 'fixture' }));
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({
        contents: path.endsWith('.css') ? ''
          : path.includes('TenantBrandingContext') ? 'export const useTenantBranding = () => ({});'
          : path.includes('resetConsentRuntime') ? 'export const resetConsentRuntime = () => {};'
          : path.includes('consentTracking') ? 'export const disableTracking=()=>{}, enableTracking=()=>{}, trackConsentPage=()=>{}, clearTrackingStorage=()=>{};'
          : path.includes('/scripts') ? 'export const ga4=()=>{};'
          : 'export const CookieBanner=()=>null, CookiePreferences=()=>null, RecallButton=()=>null; export const initCookieYes=()=>{globalThis.__consentSdkStarts++;};',
        loader: 'js',
      }));
    },
  }],
});
const compiled = new Module(`${process.cwd()}/cookie-consent-embed-fixture.cjs`);
compiled.filename = `${process.cwd()}/cookie-consent-embed-fixture.cjs`;
compiled.paths = Module._nodeModulePaths(process.cwd());
compiled._compile(result.outputFiles[0].text, compiled.filename);
after(() => { globalThis.fetch = originalFetch; dom.window.close(); });

test('embedded forms render no consent UI and perform no consent requests or SDK startup', async () => {
  dom.window.history.replaceState({}, '', '/embed/form/example');
  Object.defineProperty(dom.window, 'self', { configurable: true, value: {} });
  let requests = 0;
  globalThis.__consentSdkStarts = 0;
  globalThis.fetch = async () => { requests++; throw new Error('Fixture: unavailable'); };
  const root = createRoot(document.getElementById('root'));
  await React.act(async () => root.render(React.createElement(compiled.exports.default)));
  assert.equal(requests, 0);
  assert.equal(globalThis.__consentSdkStarts, 0);
  assert.equal(document.getElementById('root').innerHTML, '');
  await React.act(async () => root.unmount());
});

test('standalone embed URLs still request normal consent configuration', async () => {
  Object.defineProperty(dom.window, 'self', { configurable: true, value: dom.window });
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error('Fixture: unavailable'); };
  const root = createRoot(document.getElementById('root'));
  await React.act(async () => root.render(React.createElement(compiled.exports.default)));
  assert.equal(requests, 1);
  await React.act(async () => root.unmount());
});
