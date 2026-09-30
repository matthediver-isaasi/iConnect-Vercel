import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { RouteLoadingBoundary } from './RouteLoadingBoundary.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;

test('pending route keeps shell mounted and resolves without remounting on rerender', async () => {
  let resolve;
  let mounts = 0;
  const Page = lazy(() => new Promise(r => { resolve = r; }));
  function Content() {
    React.useEffect(() => { mounts++; }, []);
    return <input defaultValue="retained" />;
  }
  const container = document.createElement('div');
  const root = createRoot(container);
  const render = () => root.render(<><nav>Portal</nav><RouteLoadingBoundary resetKey="/editor"><Page /></RouteLoadingBoundary></>);
  await act(async () => render());
  const shell = container.querySelector('nav');
  assert.match(container.querySelector('[role="status"]').textContent, /Loading/);
  await act(async () => resolve({ default: Content }));
  await act(async () => render());
  assert.equal(container.querySelector('nav'), shell);
  assert.equal(mounts, 1);
  assert.equal(container.querySelector('input').value, 'retained');
  await act(async () => root.unmount());
});

test('import failure displays actionable error and navigation clears boundary', async () => {
  const Page = lazy(() => Promise.reject(new Error('Network unavailable')));
  const container = document.createElement('div');
  const root = createRoot(container);
  const previous = console.error;
  console.error = () => {};
  try {
    await act(async () => root.render(<RouteLoadingBoundary resetKey="/bad"><Page /></RouteLoadingBoundary>));
    assert.match(container.querySelector('[role="alert"]').textContent, /Unable to load/);
    assert.equal(container.querySelector('button').textContent, 'Refresh page');
    await act(async () => root.render(<RouteLoadingBoundary resetKey="/good"><p>Ready</p></RouteLoadingBoundary>));
    assert.equal(container.textContent, 'Ready');
  } finally {
    console.error = previous;
    await act(async () => root.unmount());
  }
});

test('page-owned route identity and global stale chunk integration remain intact', () => {
  const routes = readFileSync(new URL('../../pages/index.jsx', import.meta.url), 'utf8');
  for (const name of ['DynamicPage', 'ViewPage', 'HomePageRedirect']) {
    assert.match(routes, new RegExp(`import ${name} from`));
  }
  assert.match(routes, /\[DynamicPage, ViewPage, HomePageRedirect, SmartLoginRoute\]\.includes\(pageComponent\)/);
  assert.match(routes, /const FormBuilder = lazy\(\(\) => import\("\.\/FormBuilder"\)\)/);
  const boundary = readFileSync(new URL('./RouteLoadingBoundary.jsx', import.meta.url), 'utf8');
  assert.match(boundary, /handleStaleChunkError\(error\)/);
});