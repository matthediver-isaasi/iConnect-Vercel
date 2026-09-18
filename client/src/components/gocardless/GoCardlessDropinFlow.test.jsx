import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import React, { StrictMode } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import GoCardlessDropinFlow from './GoCardlessDropinFlow.jsx';

let dom;
let root;
let handlers;

beforeEach(() => {
  dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: 'https://example.test/',
  });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.navigator = dom.window.navigator;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  handlers = [];
  window.GoCardlessDropin = {
    create(options) {
      const handler = {
        options,
        opens: 0,
        exits: 0,
        open() {
          handler.opens += 1;
        },
        exit() {
          handler.exits += 1;
          options.onExit(null, { source: 'programmatic' });
        },
      };
      handlers.push(handler);
      return handler;
    },
  };
  root = createRoot(document.getElementById('root'));
});

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  dom.window.close();
  delete globalThis.window;
  delete globalThis.document;
  delete globalThis.navigator;
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});

async function render(props) {
  await act(async () => {
    root.render(
      <StrictMode>
        <GoCardlessDropinFlow {...props} />
      </StrictMode>,
    );
    await Promise.resolve();
  });
}

test('mounted StrictMode flow owns every provider handler through unmount', async () => {
  const exits = [];
  await render({
    flowId: 'BRF_one',
    environment: 'sandbox',
    onExit: (...args) => exits.push(args),
  });

  assert.equal(handlers.length, 1, 'effect replay does not leak a pre-ready handler');
  assert.equal(handlers[0].opens, 1);
  await act(async () => root.unmount());
  root = null;
  assert.equal(handlers[0].exits, 1);
  assert.deepEqual(exits, [], 'programmatic SDK exit is not presented as payer exit');
});

test('environment and keyed flow replacement exit each prior handler', async () => {
  const exits = [];
  const props = { onExit: (...args) => exits.push(args) };
  await render({ ...props, flowId: 'BRF_one', environment: 'sandbox' });
  await render({ ...props, flowId: 'BRF_one', environment: 'live' });
  await render({ ...props, flowId: 'BRF_two', environment: 'live' });

  assert.equal(handlers.length, 3);
  assert.deepEqual(
    handlers.map(({ options }) => [
      options.billingRequestFlowID,
      options.environment,
    ]),
    [
      ['BRF_one', 'sandbox'],
      ['BRF_one', 'live'],
      ['BRF_two', 'live'],
    ],
  );
  assert.deepEqual(handlers.map(handler => handler.exits), [1, 1, 0]);

  await act(async () => root.unmount());
  root = null;
  assert.deepEqual(handlers.map(handler => handler.exits), [1, 1, 1]);
  assert.deepEqual(exits, []);
});

test('provider success stays immediate and its parent-driven unmount cleans receipt', async () => {
  const successes = [];
  const exits = [];
  await render({
    flowId: 'BRF_success',
    environment: 'sandbox',
    onSuccess: (...args) => successes.push(args),
    onExit: (...args) => exits.push(args),
  });

  const handler = handlers[0];
  await act(async () => {
    handler.options.onSuccess({ id: 'BR1' }, { id: 'BRF_success' });
  });
  assert.equal(successes.length, 1);
  assert.equal(handler.exits, 0, 'success keeps the receipt until caller unmount');

  await act(async () => root.unmount());
  root = null;
  assert.equal(handler.exits, 1);
  assert.deepEqual(exits, []);
});

test('delayed script is canceled on unmount and cannot create a late handler', async () => {
  delete window.GoCardlessDropin;
  await render({
    flowId: 'BRF_delayed_unmount',
    environment: 'sandbox',
  });
  const script = document.querySelector('script[src*="gocardless.com/billing/static/dropin"]');
  assert.ok(script);

  await act(async () => root.unmount());
  root = null;
  assert.equal(script.isConnected, false);

  window.GoCardlessDropin = {
    create() {
      throw new Error('detached load listener created a handler');
    },
  };
  script.dispatchEvent(new window.Event('load'));
  assert.equal(handlers.length, 0);
});

test('timeout cancels a hung load and a fresh flow can retry cleanly', async () => {
  delete window.GoCardlessDropin;
  const failures = [];
  await render({
    flowId: 'BRF_timeout',
    environment: 'sandbox',
    loadTimeoutMs: 5,
    onLoadFailure: error => failures.push(error.message),
  });
  const hungScript = document.querySelector('script[src*="gocardless.com/billing/static/dropin"]');
  assert.ok(hungScript);
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 15));
  });
  assert.deepEqual(failures, ['GoCardless Drop-in did not load in time']);
  assert.equal(hungScript.isConnected, false);

  window.GoCardlessDropin = {
    create(options) {
      const handler = {
        options,
        opens: 0,
        exits: 0,
        open() { handler.opens += 1; },
        exit() { handler.exits += 1; options.onExit(null, {}); },
      };
      handlers.push(handler);
      return handler;
    },
  };
  hungScript.dispatchEvent(new window.Event('load'));
  assert.equal(handlers.length, 0, 'late completion after timeout stays canceled');

  await render({
    flowId: 'BRF_retry',
    environment: 'sandbox',
    onLoadFailure: error => failures.push(error.message),
  });
  assert.equal(handlers.length, 1);
  assert.equal(handlers[0].opens, 1);
});

test('failed script is removed and fresh flow retry loads a replacement', async () => {
  delete window.GoCardlessDropin;
  const failures = [];
  await render({
    flowId: 'BRF_failed',
    environment: 'sandbox',
    onLoadFailure: error => failures.push(error.message),
  });
  const failedScript = document.querySelector('script[src*="gocardless.com/billing/static/dropin"]');
  failedScript.dispatchEvent(new window.Event('error'));
  assert.deepEqual(failures, ['Failed to load GoCardless Drop-in']);
  assert.equal(failedScript.isConnected, false);

  await render({
    flowId: 'BRF_failed_retry',
    environment: 'live',
    onLoadFailure: error => failures.push(error.message),
  });
  const retryScript = document.querySelector('script[src*="gocardless.com/billing/static/dropin"]');
  assert.ok(retryScript);
  assert.notEqual(retryScript, failedScript);
  window.GoCardlessDropin = {
    create(options) {
      const handler = {
        options,
        opens: 0,
        exits: 0,
        open() { handler.opens += 1; },
        exit() { handler.exits += 1; options.onExit(null, {}); },
      };
      handlers.push(handler);
      return handler;
    },
  };
  retryScript.dispatchEvent(new window.Event('load'));
  assert.equal(handlers.length, 1);
  assert.equal(handlers[0].options.environment, 'live');
});