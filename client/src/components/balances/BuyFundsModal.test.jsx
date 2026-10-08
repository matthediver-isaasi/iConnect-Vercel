import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  localStorage: dom.window.localStorage, sessionStorage: dom.window.sessionStorage,
  HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement,
  Element: dom.window.Element, Node: dom.window.Node, NodeFilter: dom.window.NodeFilter,
  Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, MouseEvent: dom.window.MouseEvent,
  MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle,
  requestAnimationFrame: cb => setTimeout(cb, 0), cancelAnimationFrame: clearTimeout,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const React = (await import('react')).default;
globalThis.React = React;
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { Simulate } = await import('react-dom/test-utils');
const { base44 } = await import('@/api/base44Client');
const { default: BuyFundsModal } = await import('./BuyFundsModal.jsx');
after(() => dom.window.close());

test('queued modal preserves request across retry and remount; never presents pending as invoice success', async () => {
  const key = 'training-fund-checkout:test-scope';
  const requestKey = '00000000-0000-4000-8000-000000000010';
  sessionStorage.setItem(key, JSON.stringify({ amount: '42.50', paymentMethod: 'invoice',
    poNumber: '', poToFollow: false, requestKey }));
  const original = base44.functions.invoke;
  const calls = [];
  let completed = 0;
  let ready = false;
  base44.functions.invoke = async (name, params) => {
    calls.push({ name, params });
    return { success: true, purchaseId: 'purchase', queued: !ready, accountingState: 'retry' };
  };
  let root; let host;
  const mount = async () => {
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    await act(async () => root.render(<BuyFundsModal open checkoutScope="test-scope"
      onOpenChange={() => {}} onCompleted={() => completed++} />));
  };
  const unmount = async () => { await act(async () => root.unmount()); host.remove(); };
  const click = async () => act(async () =>
    document.querySelector('[data-testid="button-buy-funds-continue"]').click());
  try {
    await mount();
    assert.ok(document.querySelector('[data-testid="buy-funds-queued"]'));
    await click();
    assert.equal(completed, 0);
    assert.match(document.body.textContent, /No funds are available until payment is confirmed/);
    assert.equal(document.querySelector('[data-testid="input-buy-funds-amount"]').disabled, true);
    await unmount(); await mount(); await click();
    assert.equal(completed, 0);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].params.requestKey, requestKey);
    assert.deepEqual(calls[0], calls[1]);
    ready = true; await click();
    assert.equal(completed, 1);
    assert.equal(sessionStorage.getItem(key), null);
  } finally {
    await unmount();
    base44.functions.invoke = original;
  }
});

test('sub-penny input stays editable; confirmed non-acceptance unlocks saved input but uncertain failure does not', async () => {
  const key = 'training-fund-checkout:rejected-scope';
  const original = base44.functions.invoke;
  let outcome = 'rejected'; const calls = [];
  base44.functions.invoke = async (_name, params) => {
    calls.push(params);
    if (outcome === 'uncertain') throw new Error('lost response');
    return { success: false, purchaseNotAccepted: true, error: 'Amount must have at most two decimal places' };
  };
  const host = document.createElement('div'); document.body.append(host);
  let root = createRoot(host);
  const render = async () => act(async () => root.render(<BuyFundsModal open checkoutScope="rejected-scope"
    onOpenChange={() => {}} />));
  const amount = () => document.querySelector('[data-testid="input-buy-funds-amount"]');
  const button = () => document.querySelector('[data-testid="button-buy-funds-continue"]');
  const change = async value => act(async () => Simulate.change(amount(), { target: { value } }));
  try {
    await render();
    await change('0.001');
    assert.equal(button().disabled, true);
    assert.equal(amount().disabled, false);
    assert.equal(calls.length, 0);
    await change('1.00');
    assert.equal(button().disabled, false);
    await act(async () => button().click());
    assert.equal(amount().disabled, false);
    assert.equal(sessionStorage.getItem(key), null);
    // A previously saved invalid attempt can ask the server to confirm absence;
    // it cannot be permanently trapped by the client-side amount check.
    await act(async () => root.unmount());
    sessionStorage.setItem(key, JSON.stringify({ amount: '0.001', paymentMethod: 'invoice',
      requestKey: '00000000-0000-4000-8000-000000000010' }));
    root = createRoot(host); await render();
    assert.equal(button().disabled, false);
    await act(async () => button().click());
    assert.equal(amount().disabled, false);
    await change('42.50');
    outcome = 'uncertain';
    await act(async () => button().click());
    assert.equal(amount().disabled, true);
    assert.ok(sessionStorage.getItem(key));
    const lastKey = calls.at(-1).requestKey;
    await act(async () => button().click());
    assert.equal(calls.at(-1).requestKey, lastKey);
  } finally {
    await act(async () => root.unmount()); host.remove();
    base44.functions.invoke = original; sessionStorage.removeItem(key);
  }
});
