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

test('slow portal discovery preserves established shell DOM without inheriting destination authority', async () => {
  let context;
  let mounts = 0;
  function Portal({ children }) {
    useLayoutEffect(() => { mounts += 1; }, []);
    return <section><header><input defaultValue="shell state" /></header><aside /><main>{children}</main></section>;
  }
  function Page({ decision }) {
    usePageLayoutDecision(decision);
    return <p>Destination</p>;
  }
  function Shell({ decision }) {
    context = useContext(RouteLayoutContext);
    useLayoutEffect(() => {
      if (context.chromeReady) context.confirmPortalShell?.(!context.forcePublicLayout);
    }, [context.confirmPortalShell, context.forcePublicLayout, context.chromeReady]);
    const content = <div hidden={!context.chromeReady}><Page decision={decision} /></div>;
    return context.forcePublicLayout ? <article>{content}</article> : <Portal>{content}</Portal>;
  }
  const container = document.createElement('div');
  const root = createRoot(container);
  const portal = { forcePublicLayout: false };
  const render = (scope, decision, shellScope = 'tenant/member/session/role') => act(async () => {
    root.render(<RouteLayoutProvider scope={scope} shellScope={shellScope} pageOwned>
      <Shell decision={decision} />
    </RouteLayoutProvider>);
  });
  try {
    await render('/bookings', portal);
    const header = container.querySelector('header');
    header.querySelector('input').value = 'expanded navigation';
    const abandonedCommit = context.commit;
    const abandonedConfirmation = context.confirmPortalShell;
    for (const route of ['/portal', '/bookings?back', '/portal?forward', '/portal?repeat']) {
      await render(route, null);
      assert.equal(container.querySelector('header'), header, `shell changed during slow discovery of ${route}`);
      assert.equal(context.chromeReady, false);
      assert.equal(context.publicChrome, 'none');
      await act(async () => abandonedCommit({ forcePublicLayout: true }));
      await act(async () => abandonedConfirmation(false));
      assert.equal(context.chromeReady, false, 'previous route cannot authorize destination');
      assert.equal(container.querySelector('header'), header, 'abandoned confirmation cannot discard current shell');
      await render(route, portal);
    }
    assert.equal(mounts, 1);
    assert.equal(header.querySelector('input').value, 'expanded navigation');
    await render('/public', { forcePublicLayout: true });
    assert.equal(container.querySelector('header'), null);
    await render('/unknown', null);
    assert.equal(context.forcePublicLayout, true, 'public destination clears established portal continuity');
    for (const terminal of ['unknown', 'error']) {
      await render('/member', portal);
      await render(`/${terminal}-pending`, null);
      assert.equal(context.chromeReady, false, 'unresolved error/miss cannot reveal destination');
      await render(`/${terminal}-pending`, { forcePublicLayout: true, publicChrome: 'none' });
      assert.equal(container.querySelector('header'), null, 'terminal error/miss obeys explicit no-chrome policy');
      assert.equal(context.publicChrome, 'none');
      assert.equal(context.chromeReady, true, 'terminal feedback can be shown');
    }
    await render('/member', portal);
    await render('/blank', { forcePublicLayout: true, forceBlankLayout: true });
    assert.equal(container.querySelector('header'), null);
    for (const boundary of ['tenant-b', 'member-b', 'session-b', 'role-b', 'microsite', null]) {
      await render('/member', portal);
      await render('/portal', null, boundary);
      assert.equal(container.querySelector('header'), null, `${boundary} cannot inherit shell`);
      assert.equal(context.chromeReady, false);
    }
  } finally {
    await act(async () => root.unmount());
  }
});

test('static portal confirmation can retain only presentation for a page-owned destination', async () => {
  let context;
  function Reader() {
    context = useContext(RouteLayoutContext);
    return null;
  }
  const root = createRoot(document.createElement('div'));
  const render = (scope, pageOwned, shellScope = 'validated-session') => act(async () => {
    root.render(<RouteLayoutProvider scope={scope} pageOwned={pageOwned} shellScope={shellScope}>
      <Reader />
    </RouteLayoutProvider>);
  });
  try {
    await render('/portal', true);
    assert.equal(context.forcePublicLayout, true, 'direct entry has no established shell');
    await render('/bookings', false);
    await act(async () => context.confirmPortalShell());
    await render('/portal', true);
    assert.equal(context.forcePublicLayout, false);
    assert.equal(context.chromeReady, false);
    assert.equal(context.forceBlankLayout, false);
    assert.equal(context.publicPageMisses.size, 0);
    await render('/portal', true, null);
    assert.equal(context.forcePublicLayout, true, 'auth/role readiness closure fences presentation immediately');
    await render('/portal', true);
    assert.equal(context.forcePublicLayout, true, 'reopened trust cannot revive prior shell evidence');
  } finally {
    await act(async () => root.unmount());
  }
});

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