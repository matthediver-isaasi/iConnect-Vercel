import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://event.test/' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? dom.window : dom.window[key] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const require = Module.createRequire(import.meta.url);
// Match the bundled CJS component's conditional package exports.
const { QueryClient, QueryClientProvider } = require('@tanstack/react-query');
const { MemoryRouter } = require('react-router-dom');
const stubs = {
  '@/api/publicClient': `export const publicClient={getComplexEventBySlug:()=>globalThis.loadingTest.lookup('slug'),getComplexEvent:()=>globalThis.loadingTest.lookup('id'),getComplexEventSessions:async()=>[],listSystemSettings:async()=>[],listSpeakers:async()=>[]};`,
  '@/api/supabaseClient': 'export const supabase={};',
  '@/hooks/useMemberAccess': 'export const useMemberAccess=()=>({authResolved:true,sessionValidated:true,roleStatus:"ready"});',
  '@/hooks/useTicketViewerKey': 'export const useTicketViewerKey=()=>["guest"];',
  '@/hooks/useEventsData': 'export const useMyGroupIds=()=>({data:[],isFetched:true});',
  '@/components/auth/useEventLogin': 'export const useEventLogin=()=>({openLogin:()=>{},loginModal:null});',
  '@/hooks/useComplexEventTicketAvailabilityRealtime': 'export const useComplexEventTicketAvailabilityRealtime=()=>{};',
};
const bundle = await build({
  entryPoints: ['client/src/pages/ComplexEventDetail.jsx'], bundle: true, write: false,
  platform: 'node', format: 'cjs', jsx: 'automatic', packages: 'external',
  loader: { '.css': 'empty' },
  plugins: [{
    name: 'loading-fixtures',
    setup(b) {
      b.onResolve({ filter: /^@\// }, args => {
        if (stubs[args.path]) return { path: args.path, namespace: 'fixture' };
        // Child widgets do not participate in lookup/error state.
        if (args.path.startsWith('@/components/') && !args.path.includes('/ui/') && !args.path.includes('ComplexEventSchedule') && !args.path.includes('EventDisclosure')) {
          return { path: 'empty', namespace: 'fixture' };
        }
      });
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({
        contents: path === 'empty' ? 'export default ()=>null; export const getFocalPointStyle=()=>({});' : stubs[path],
      }));
    },
  }],
});
const mod = new Module('detail-loading-test', import.meta.url);
mod.paths = Module._nodeModulePaths(process.cwd());
mod._compile(bundle.outputFiles[0].text, `${process.cwd()}/detail-loading-test.cjs`);
const Detail = mod.exports.ComplexEventDetailExperience;

for (const mode of ['slug', 'id']) {
  test(`${mode} lookup: service error retries and genuine 404 remains not-found`, async () => {
    const calls = [];
    let status = 503;
    globalThis.loadingTest = { lookup: async kind => {
      calls.push(kind);
      throw Object.assign(new Error('fixture error'), { status });
    } };
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const flush = () => React.act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); });
    await React.act(async () => root.render(React.createElement(QueryClientProvider, { client },
      React.createElement(MemoryRouter, null, React.createElement(Detail, mode === 'slug' ? { eventSlug: 'meeting' } : { eventId: 'event' })))));
    await flush();
    assert.ok(container.querySelector('[data-testid="text-event-load-error"]'));
    assert.equal(container.querySelector('[data-testid="text-event-not-found"]'), null);
    status = 404;
    await React.act(async () => container.querySelector('[data-testid="button-retry-event"]').click());
    await flush();
    assert.deepEqual(calls, [mode, mode]);
    assert.ok(container.querySelector('[data-testid="text-event-not-found"]'));
    await React.act(async () => root.unmount());
    client.clear();
    container.remove();
  });
}
