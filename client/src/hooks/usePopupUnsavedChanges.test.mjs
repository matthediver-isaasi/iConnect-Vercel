import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://fixture.invalid/' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node']) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { BrowserRouter } = await import('react-router-dom');
const { usePopupUnsavedChanges } = await import('./usePopupUnsavedChanges.js');

async function mount(options) {
  const node = document.createElement('div'); document.body.append(node);
  const root = createRoot(node);
  let guard;
  function Probe() { guard = usePopupUnsavedChanges(options); return null; }
  const render = () => act(async () => root.render(React.createElement(BrowserRouter, null, React.createElement(Probe))));
  await render();
  return { get guard() { return guard; }, render,
    close: async () => { await act(async () => root.unmount()); node.remove(); } };
}

test('mounted guard saves and stays without running destination, then permits a new request', async () => {
  let calls = 0, destinations = 0;
  const f = await mount({ dirty: true, onSave: async ({ leave }) => { assert.equal(leave, false); calls++; return true; } });
  try {
    await act(async () => f.guard.request(() => destinations++));
    await act(async () => f.guard.saveAndStay());
    assert.equal(calls, 1); assert.equal(destinations, 0); assert.equal(f.guard.pending, null);
    await act(async () => f.guard.request(() => destinations++));
    await act(async () => f.guard.discard());
    assert.equal(destinations, 1);
  } finally { await f.close(); }
});

test('mounted guard rejects duplicate saves and conflicting dismissal synchronously', async () => {
  let resolve, calls = 0, destinations = 0;
  const f = await mount({ dirty: true, onSave: () => { calls++; return new Promise(done => { resolve = done; }); } });
  try {
    await act(async () => f.guard.request(() => destinations++));
    let save;
    await act(async () => {
      save = f.guard.saveAndLeave();
      f.guard.saveAndLeave(); f.guard.saveAndStay(); f.guard.discard(); f.guard.stay();
    });
    assert.equal(calls, 1); assert.equal(destinations, 0); assert.equal(f.guard.pending, true);
    await act(async () => { resolve(true); await save; });
    assert.equal(destinations, 1); assert.equal(f.guard.pending, null);
  } finally { await f.close(); }
});

test('mounted guard preserves popup false/throwing-save and stay/discard behavior', async () => {
  let destinations = 0;
  const options = { dirty: true, onSave: async () => false };
  const f = await mount(options);
  try {
    await act(async () => f.guard.request(() => destinations++));
    await act(async () => f.guard.saveAndLeave());
    assert.equal(f.guard.pending, true); assert.match(f.guard.error, /not saved/);
    options.onSave = async () => { throw new Error('Save unavailable'); };
    await f.render();
    await act(async () => f.guard.saveAndLeave());
    assert.equal(f.guard.error, 'Save unavailable');
    await act(async () => f.guard.stay());
    assert.equal(destinations, 0); assert.equal(f.guard.pending, null);
    await act(async () => f.guard.request(() => destinations++));
    await act(async () => f.guard.discard());
    assert.equal(destinations, 1);
  } finally { await f.close(); }
});

test('mounted guard native unload follows live dirty state and unregisters on unmount', async () => {
  const options = { dirty: false };
  const f = await mount(options);
  const blocked = () => !window.dispatchEvent(new window.Event('beforeunload', { cancelable: true }));
  assert.equal(blocked(), false);
  options.dirty = true; await f.render();
  assert.equal(blocked(), true);
  await f.close();
  assert.equal(blocked(), false);
});
