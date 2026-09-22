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

test('public miss evidence survives shell remount only, not readiness, route or audience changes', async () => {
  let context;
  function Reader() {
    context = useContext(RouteLayoutContext);
    return null;
  }
  const root = createRoot(document.createElement('div'));
  const render = (scope, prerequisitesReady = true, childKey = 'initial') => act(async () => {
    root.render(
      <RouteLayoutProvider scope={scope} pageOwned prerequisitesReady={prerequisitesReady}>
        <Reader key={childKey} />
      </RouteLayoutProvider>,
    );
  });
  try {
    await render('route-a/member-a');
    context.publicPageMisses.add('portal');
    await render('route-a/member-a', true, 'portal-shell');
    assert.equal(context.publicPageMisses.has('portal'), true);
    await render('route-a/member-a', false);
    assert.equal(context.publicPageMisses.size, 0);
    await render('route-a/member-a');
    context.publicPageMisses.add('portal');
    await render('route-a/member-b');
    assert.equal(context.publicPageMisses.size, 0);
    context.publicPageMisses.add('portal');
    await render('route-b/member-b');
    assert.equal(context.publicPageMisses.size, 0);
  } finally {
    await act(async () => root.unmount());
  }
});

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
    await render('blank', null, false);
    assert.equal(context.forceBlankLayout, true, 'temporary prerequisite loading preserves the resolved blank shell');
    assert.equal(context.chromeReady, false);
    await render('blank', { ...decision('both'), forceBlankLayout: true });
    assert.equal(context.forceBlankLayout, true);
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

test('route and audience scopes isolate public, blank, portal, and microsite decisions', async () => {
  let context;
  function Page({ decision }) {
    context = useContext(RouteLayoutContext);
    usePageLayoutDecision(decision);
    return <span />;
  }
  const container = document.createElement('div');
  const root = createRoot(container);
  async function render(scope, decision, prerequisitesReady = true) {
    await act(async () => root.render(
      <RouteLayoutProvider scope={scope} pageOwned prerequisitesReady={prerequisitesReady}>
        <Page decision={decision} />
      </RouteLayoutProvider>,
    ));
  }
  try {
    await render('tenant-a:guest:/public', {
      publicChrome: 'header',
      forcePublicLayout: true,
      forceBlankLayout: false,
    });
    assert.equal(context.publicChrome, 'header');

    await render('tenant-a:member-a:role-a:/portal', null);
    assert.equal(context.chromeReady, false);
    assert.equal(context.publicChrome, 'none', 'destination cannot inherit public chrome');
    assert.equal(context.forcePublicLayout, true, 'unresolved destination stays in its safe fallback shell');

    await render('tenant-a:member-a:role-a:/portal', {
      publicChrome: 'both',
      forcePublicLayout: false,
      forceBlankLayout: false,
    });
    assert.equal(context.forcePublicLayout, false);
    await render('tenant-a:member-a:role-a:/portal', null, false);
    assert.equal(context.forcePublicLayout, false, 'temporary readiness does not move resolved portal content');
    assert.equal(context.chromeReady, false);

    await render('tenant-a:member-a:role-b:/portal', null);
    assert.equal(context.forcePublicLayout, true, 'role boundary gets a new unresolved lease');
    assert.equal(context.publicChrome, 'none');

    await render('tenant-a:guest:/microsite-a/page', {
      publicChrome: 'footer',
      forcePublicLayout: true,
      forceBlankLayout: false,
    });
    assert.equal(context.publicChrome, 'footer');
    await render('tenant-a:guest:/microsite-b/page', null);
    assert.equal(context.publicChrome, 'none', 'microsite boundary cannot reuse another site chrome');

    await render('tenant-a:guest:/blank', {
      publicChrome: 'both',
      forcePublicLayout: true,
      forceBlankLayout: true,
    });
    assert.equal(context.forceBlankLayout, true);
    await render('tenant-a:guest:/public-again', null);
    assert.equal(context.forceBlankLayout, false, 'blank mode cannot leak into a destination');
  } finally {
    await act(async () => root.unmount());
  }
});