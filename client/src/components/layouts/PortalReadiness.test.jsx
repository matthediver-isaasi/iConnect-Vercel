import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import PortalReadiness from './PortalReadiness.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;

test('readiness and retry preserve mounted content and unsaved input', async () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  let mounts = 0;
  let retries = 0;
  function Content() {
    useEffect(() => { mounts += 1; }, []);
    return <input defaultValue="initial" />;
  }
  const render = (ready, error) => act(async () => root.render(
    <PortalReadiness ready={ready} error={error} onRetry={() => { retries += 1; }}>
      <Content />
    </PortalReadiness>,
  ));
  try {
    await render(false);
    assert.match(container.querySelector('[role="status"]').textContent, /Loading portal/);
    const input = container.querySelector('input');
    assert.ok(input.closest('[hidden]'));
    await render(true);
    input.value = 'unsaved answer';
    await render(false, new Error('Unable to verify your session.'));
    assert.match(container.querySelector('[role="alert"]').textContent, /Unable to verify/);
    assert.ok(input.closest('[hidden]'));
    await act(async () => container.querySelector('button').click());
    assert.equal(retries, 1);
    await render(true);
    assert.equal(container.querySelector('input'), input);
    assert.equal(input.value, 'unsaved answer');
    assert.equal(mounts, 1);
    assert.equal(input.closest('[hidden]'), null);
  } finally {
    await act(async () => root.unmount());
  }
});

test('blocked recovery announces progress, disables retry, and preserves its content subtree', async () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  const render = recovering => act(async () => root.render(
    <PortalReadiness ready={false} error={new Error('Unable to verify your session.')}
      recovering={recovering} onRetry={() => {}} retryLabel="Retry">
      <input defaultValue="draft" />
    </PortalReadiness>,
  ));
  try {
    await render(false);
    const input = container.querySelector('input');
    input.value = 'retained';
    await render(true);
    assert.match(container.querySelector('[role="status"]').textContent, /Reconnecting to your session/);
    assert.equal(container.querySelector('button').disabled, true);
    assert.equal(container.querySelector('button').textContent, 'Retrying…');
    assert.equal(container.querySelector('input'), input);
    assert.ok(input.closest('[hidden]'));
    await render(false);
    assert.equal(input.value, 'retained');
    assert.equal(container.querySelector('button').disabled, false);
    assert.equal(container.querySelector('button').textContent, 'Retry');
  } finally {
    await act(async () => root.unmount());
  }
});

test('transient and offline feedback leaves retained content visible and successful initial checks quiet', async () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  const render = (recovering, offline = false) => act(async () => root.render(
    <PortalReadiness ready recovering={recovering} offline={offline}>
      <input defaultValue="draft" />
    </PortalReadiness>,
  ));
  try {
    await render(false);
    const input = container.querySelector('input');
    assert.equal(container.querySelector('[role="status"]'), null);
    input.value = 'live draft';
    await render(true);
    assert.match(container.querySelector('[role="status"]').textContent, /Reconnecting to your session/);
    assert.equal(input.closest('[hidden]'), null);
    await render(true, true);
    assert.match(container.querySelector('[role="status"]').textContent, /offline/);
    assert.equal(container.querySelector('input'), input);
    assert.equal(input.value, 'live draft');
    await render(false);
    assert.equal(container.querySelector('[role="status"]'), null);
  } finally {
    await act(async () => root.unmount());
  }
});