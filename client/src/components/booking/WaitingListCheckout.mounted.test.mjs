import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://isolated.example.test/EventDetails' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? dom.window : dom.window[key] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = (await import('react')).default;
const { act } = React;
const { createRoot } = await import('react-dom/client');
const calls = [];
let fail = true;
let logins = 0;
globalThis.__waitingListTest = {
  request: async (url, options) => {
    calls.push({ url, ...JSON.parse(options.body) });
    if (fail) throw new Error('Temporary network failure');
    return { registration_id: 'r7', entries: [] };
  },
  login: () => { logins++; },
};
const bundle = await build({
  entryPoints: ['client/src/components/booking/WaitingListCheckout.jsx'],
  bundle: true, write: false, platform: 'node', packages: 'external', format: 'cjs', jsx: 'automatic',
  plugins: [{
    name: 'isolated-waiting-checkout',
    setup(build) {
      build.onResolve({ filter: /^@\/|^uuid$|^@tanstack\/react-query$|^react-router-dom$/ }, args => {
        if (args.path === '@/lib/eventWaitingList.mjs') return { path: new URL('../../lib/eventWaitingList.mjs', import.meta.url).pathname };
        return { path: args.path, namespace: 'isolated' };
      });
      build.onLoad({ filter: /.*/, namespace: 'isolated' }, args => {
        let contents;
        if (args.path === 'uuid') contents = `export const v4 = () => '9a475cac-16b2-49ba-b394-4735ed6a8b1e';`;
        else if (args.path === '@tanstack/react-query') contents = `export const useQuery = () => ({ data: [], isLoading: false, isError: false }); export const useQueryClient = () => ({ invalidateQueries() {} });`;
        else if (args.path === 'react-router-dom') contents = `import React from 'react'; export const Link = ({to,children,...props}) => <a href={to} {...props}>{children}</a>;`;
        else if (args.path.endsWith('useMemberAccess')) contents = `export const useMemberAccess = () => ({ authResolved: true, sessionValidated: true, roleStatus: 'ready' });`;
        else if (args.path.endsWith('useEventLogin')) contents = `export const useEventLogin = () => ({ openLogin: globalThis.__waitingListTest.login, loginModal: null });`;
        else if (args.path.endsWith('useEventWaitingList')) contents = `export const waitingListRequest = (...args) => globalThis.__waitingListTest.request(...args);`;
        else if (args.path.endsWith('publicClient')) contents = `export const publicClient = { listSystemSettings: async () => [] };`;
        else if (args.path.endsWith('/button')) contents = `import React from 'react'; export const Button = ({children,variant,...props}) => <button {...props}>{children}</button>;`;
        else if (args.path.endsWith('/checkbox')) contents = `import React from 'react'; export const Checkbox = ({onCheckedChange,...props}) => <input type="checkbox" onChange={e => onCheckedChange(e.target.checked)} {...props} />;`;
        else contents = `import React from 'react'; const Box = ({children,...props}) => <div {...props}>{children}</div>; export const Card=Box, CardHeader=Box, CardTitle=Box, CardContent=Box;`;
        return { contents, loader: 'jsx', resolveDir: process.cwd() };
      });
    },
  }],
});
const compiled = new Module('waiting-checkout-isolated', import.meta.url);
compiled.paths = modulePaths();
function modulePaths() {
  return Module._nodeModulePaths(process.cwd());
}
compiled._compile(bundle.outputFiles[0].text, `${process.cwd()}/waiting-checkout-isolated.cjs`);
const Checkout = compiled.exports.default;
const memberInfo = { id: 'member7', tenant_id: 'tenant8' };
const defaults = {
  event: { id: 'event2', waiting_list_enabled: true },
  memberInfo, selectedTicketClass: { id: 'ticket3' },
  attendees: [{ first_name: 'Mira', last_name: 'Shah', email: 'mira@example.org', dietary_selections: ['Vegetarian'] }],
};
async function mount(props) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(Checkout, props)); });
  return { host, close: async () => { await act(async () => root.unmount()); host.remove(); } };
}
async function click(element) {
  await act(async () => { element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
}
test('retry keeps the UUID and sends only waiting-list registration, then renders unambiguous success', async () => {
  calls.length = 0;
  fail = true;
  const view = await mount(defaults);
  const button = view.host.querySelector('[data-testid="button-join-waiting-list"]');
  assert.equal(button.disabled, false);
  await click(button);
  assert.match(view.host.textContent, /Temporary network failure/);
  fail = false;
  await click(button);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].idempotency_key, calls[1].idempotency_key);
  assert.equal(calls[0].url, '/api/member/event-waiting-list');
  assert.equal(calls[0].event_kind, 'simple');
  assert.deepEqual(calls[0].attendees[0].dietary_selections, ['Vegetarian']);
  assert.match(view.host.textContent, /You're on the waiting list!/);
  assert.match(view.host.textContent, /not a confirmed booking/);
  await view.close();
});
test('guests must log in, and incomplete attendees cannot submit', async () => {
  const guest = await mount({ ...defaults, memberInfo: null });
  assert.equal(guest.host.querySelector('[data-testid="button-join-waiting-list"]'), null);
  await click(guest.host.querySelector('button'));
  assert.equal(logins, 1);
  await guest.close();
  const invalid = await mount({ ...defaults, attendees: [{ first_name: 'Mira', email: 'invalid' }] });
  assert.equal(invalid.host.querySelector('[data-testid="button-join-waiting-list"]').disabled, true);
  await invalid.close();
});
test('complex preferences retain each selected ticket/session without a normal booking call', async () => {
  fail = false;
  calls.length = 0;
  const view = await mount({ ...defaults, isComplexEvent: true, waitingListItems: [{
    ticket_class_id: 'multi-ticket', attendees: [{ ...defaults.attendees[0], session_ids: ['s4'], option_ids: ['o2'] }],
  }] });
  await click(view.host.querySelector('[data-testid="button-join-waiting-list"]'));
  assert.equal(calls[0].event_kind, 'complex');
  assert.equal(calls[0].attendees[0].ticket_class_id, 'multi-ticket');
  assert.deepEqual(calls[0].attendees[0].session_ids, ['s4']);
  await view.close();
});
after(() => { delete globalThis.__waitingListTest; dom.window.close(); });
