import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act, useContext, useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { RouteLayoutProvider, RouteLayoutContext, usePageLayoutDecision } from './RouteLayoutContext.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;

test('route decisions gate mounts, reject abandoned leases, and preserve content state', async () => {
  const history = [];
  let context;
  function Chrome({ kind }) {
    useLayoutEffect(() => { history.push(kind); }, []);
    return kind === 'header' ? <header /> : <footer />;
  }
  function Content({ decision }) {
    usePageLayoutDecision(decision);
    return <input defaultValue="initial" />;
  }
  function Shell({ decision }) {
    context = useContext(RouteLayoutContext);
    return <main>
      {context.chromeReady && ['both', 'header'].includes(context.publicChrome) && <Chrome kind="header" />}
      <Content decision={decision} />
      {context.chromeReady && ['both', 'footer'].includes(context.publicChrome) && <Chrome kind="footer" />}
    </main>;
  }
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  async function render(scope, decision, prerequisitesReady = true, pageOwned = true) {
    await act(async () => root.render(
      <RouteLayoutProvider scope={scope} pageOwned={pageOwned} prerequisitesReady={prerequisitesReady}>
        <Shell decision={decision} />
      </RouteLayoutProvider>,
    ));
  }
  const decision = publicChrome => ({ publicChrome, forcePublicLayout: true });
  try {
    await render('cold', null);
    assert.deepEqual(history, []);
    const input = container.querySelector('input');
    input.value = 'unsaved form answer';
    await render('cold', decision('both'), false);
    assert.deepEqual(history, [], 'resolved page cannot bypass pending route metadata');
    await render('cold', decision('none'));
    assert.deepEqual(history, []);
    assert.equal(container.querySelector('input'), input);
    assert.equal(input.value, 'unsaved form answer');

    await render('full', decision('both'));
    assert.deepEqual(history, ['header', 'footer']);
    const abandonedCommit = context.commit;
    const abandonedCleanup = context.setForceBlankLayout;
    await render('next', null);
    assert.equal(container.querySelectorAll('header,footer').length, 0);
    await act(async () => abandonedCommit(decision('both')));
    assert.equal(container.querySelectorAll('header,footer').length, 0);
    await render('next', decision('header'));
    assert.equal(container.querySelectorAll('footer').length, 0);
    await act(async () => abandonedCleanup(true));
    assert.equal(context.forceBlankLayout, false, 'abandoned form cleanup cannot change destination layout');
    assert.deepEqual(history, ['header', 'footer', 'header']);
    await act(async () => abandonedCommit(decision('both')));
    assert.equal(container.querySelectorAll('header').length, 1, 'late commit cannot revoke the current lease either');
    assert.equal(container.querySelectorAll('footer').length, 0);
    await render('footer-only', decision('footer'));
    assert.equal(container.querySelectorAll('header').length, 0);
    assert.deepEqual(history, ['header', 'footer', 'header', 'footer']);
    await render('blank', { ...decision('both'), forceBlankLayout: true });
    assert.equal(container.querySelectorAll('header,footer').length, 0);
    await render('blank', null);
    assert.equal(context.forcePublicLayout, true, 'blank shell remains public during refetch');
    await render('portal', { publicChrome: 'both', forcePublicLayout: false });
    await render('portal', null);
    assert.equal(context.forcePublicLayout, false, 'portal readiness cannot switch the content parent');
    await render('static', null, false, false);
    assert.equal(container.querySelectorAll('header,footer').length, 2, 'known static route is independently ready');
    await render('full', null);
    assert.equal(container.querySelectorAll('header,footer').length, 0, 'back navigation cannot revive earlier decision');
    assert.equal(container.querySelector('input'), input);
    assert.equal(input.value, 'unsaved form answer');
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});