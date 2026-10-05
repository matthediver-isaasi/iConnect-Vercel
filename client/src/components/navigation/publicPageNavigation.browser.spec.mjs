import { test, expect } from '@playwright/test';

const origin = new URL(process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:5000').origin;
const member = { id: 'navigation-member', tenant_id: 'navigation-tenant', role_id: 'navigation-role',
  first_name: 'Ruth', last_name: 'Morgan', email: 'ruth@example.invalid', member_excluded_features: [] };
const role = { id: member.role_id, tenant_id: member.tenant_id, name: 'Navigation member', excluded_features: [] };
const micro = { id: 'navigation-micro', path_prefix: 'branch', home_slug: 'nav-a', name: 'Branch fixture', is_active: true };
function deferred() {
  let release;
  return { promise: new Promise(resolve => { release = resolve; }), release: () => release() };
}
function pageRecord(slug, prefix) {
  const path = prefix ? '/branch' : '';
  return {
    id: `${prefix || 'main'}-${slug}`, tenant_id: member.tenant_id, slug, title: slug, status: 'published',
    builder_type: 'canvas', layout_type: 'public', public_chrome: 'both', hide_chrome: slug === 'nav-hidden',
    canvas_design: { version: 1, root: { groups: [], guides: { vertical: [], horizontal: [] }, sections: [{
      id: 'navigation-section', type: 'section', children: [{
        id: 'navigation-copy', type: 'custom-html', geom: { x: 0, y: 0, w: 800, h: 220 },
        bp: { desktop: { x: 0, y: 0, w: 800, h: 220 }, tablet: { x: 0, y: 0, w: 700, h: 220 }, mobile: { x: 0, y: 0, w: 350, h: 220 } },
        content: { html: `<div style="padding-top:120px"><p>Navigation content ${slug}</p>
          <a href="${path}/${slug === 'nav-a' ? 'nav-b' : 'nav-a'}">Browse next page</a>
          <a href="${path}/nav-hidden">Browse hidden page</a>
          <a href="${path}/nav-error">Browse error page</a>
          <a href="/branch/nav-b">Browse branch page</a>
          <a href="/other/nav-b">Browse other page</a>
          <p>Navigation scope ${prefix || 'main'}</p></div>` },
      }, {
        id: 'member-only-copy', type: 'custom-html', geom: { x: 0, y: 260, w: 800, h: 60 },
        bp: { desktop: { x: 0, y: 260, w: 800, h: 60 }, tablet: { x: 0, y: 260, w: 700, h: 60 }, mobile: { x: 0, y: 260, w: 350, h: 60 } },
        content: { memberOnly: true, html: '<p>Member audience secret</p>', guestMessage: 'Please sign in' },
      }],
    }] } },
  };
}
async function installFixture(page, authenticated) {
  const state = { documents: 0, authReads: 0, authenticated, pageReads: [], pageScopes: [], writes: [], gate: null, fail: false, delayMs: 0,
    activePages: new Set(), maximumActivePages: 0, hiddenSlugs: new Set() };
  for (const event of ['requestfinished', 'requestfailed']) page.on(event, request => state.activePages.delete(request));
  await page.addInitScript(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.context().route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) return route.fulfill({ status: 204, body: '' });
    if (!url.pathname.startsWith('/api/')) {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) state.documents += 1;
      return route.continue();
    }
    const json = (body, status = 200) => request.failure() ? Promise.resolve() : route.fulfill({ status, contentType: 'application/json',
      headers: { 'Cache-Control': 'private, no-store' }, body: JSON.stringify(body) });
    if (state.firstContentTiming) {
      state.timeline.push({ path: url.pathname + url.search, start: Date.now() - state.started });
      if (!url.pathname.startsWith('/api/public/page/')) {
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    }
    if (url.pathname === '/api/auth/me' && state.authGate) await state.authGate.promise;
    if (url.pathname === '/api/public/microsites' && state.catalogueGate) await state.catalogueGate.promise;
    if (url.pathname === '/api/public/portal-branding' && state.settingsFailure) return json({ error: 'Settings unavailable' }, 503);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
      if (request.method() === 'PATCH' && url.pathname === `/api/entities/Member/${member.id}`
        && Object.keys(request.postDataJSON() || {}).join() === 'last_activity') return json(member);
      state.writes.push(`${request.method()} ${url.pathname}`);
      return json({ error: 'Read-only fixture' }, 599);
    }
    if (url.pathname === '/api/auth/me') {
      state.authReads += 1;
      return state.authenticated ? json({ ...member, sessionRole: { status: 'ready', member_id: member.id,
        tenant_id: member.tenant_id, role_id: role.id, session_key: 'navigation-session', role } })
        : json({ error: 'Not authenticated' }, 401);
    }
    if (url.pathname === '/api/auth/tenant-user-me') return json({ authenticated: false }, 401);
    if (url.pathname === '/api/public/tenant-branding') return json({ success: true, branding: {
      id: member.tenant_id, name: 'Navigation fixture', headerConfig: {}, footerConfig: {},
      platformBranding: { enabled: false },
    } });
    if (url.pathname === '/api/public/portal-branding') return json({ tenantName: 'Navigation fixture', homePageSlug: 'nav-a' });
    if (url.pathname === '/api/public/microsites') return json({ microsites: state.timingFixture
      ? [micro] : [micro, { ...micro, id: 'navigation-other', path_prefix: 'other' }] });
    if (url.pathname.startsWith('/api/public/page/')) {
      state.activePages.add(request);
      state.maximumActivePages = Math.max(state.maximumActivePages, state.activePages.size);
      const slug = url.pathname.split('/').pop();
      state.pageReads.push(slug);
      state.pageScopes.push(url.searchParams.get('microsite'));
      const gate = state.gate;
      const fail = state.fail;
      if (gate) await gate.promise;
      if (state.delayMs) await new Promise(resolve => setTimeout(resolve, state.delayMs));
      if (fail) return json({ error: 'Fixture unavailable' }, 503);
      const record = pageRecord(slug, url.searchParams.get('microsite'));
      if (state.timingFixture) {
        const path = url.searchParams.get('microsite') ? '/branch' : '';
        record.canvas_design.root.sections[0].children = record.canvas_design.root.sections[0].children.slice(0, 1);
        record.canvas_design.root.sections[0].children[0].content.html = `<div style="padding-top:120px"><p>Navigation content ${slug}</p>
          <a href="${path}/${slug === 'nav-a' ? 'nav-b' : 'nav-a'}">Browse next page</a>
          <a href="${path}/nav-hidden">Browse hidden page</a>
          <a href="${path}/nav-error">Browse error page</a></div>`;
      }
      if (state.hiddenSlugs.has(slug)) record.hide_chrome = true;
      return json({ success: true, page: record, elements: [], symbols: [] });
    }
    if (url.pathname === '/api/entities/Role' || url.pathname.startsWith('/api/entities/Role/')) return json(url.pathname.endsWith(role.id) ? role : [role]);
    if (url.pathname === '/api/entities/Member') return json([member]);
    if (url.pathname === '/api/public/article-settings') return json({});
    if (url.pathname === '/api/public/ai-help-persona' || url.pathname === '/api/member-ai/config') return json({ enabled: false });
    if (url.pathname === '/api/communication/inbox/unread-count') return json({ unreadCount: 0 });
    if (url.pathname === '/api/custom-objects') return json({ objects: [], total: 0 });
    if (url.pathname === '/api/tenant-canvas-theme') return json({ theme: null });
    if (url.pathname === '/api/public/canvas-symbols') return json({ symbols: [] });
    if (url.pathname === '/api/public/favicon-url') return json({ faviconUrl: null });
    if (url.pathname === '/api/public/platform-defaults') return json({});
    if (url.pathname.startsWith('/api/redirects/resolve')) return json({ found: false });
    return json([]);
  });
  return state;
}

test('early homepage discovery cannot expose hidden chrome or content before session policy', async ({ page }) => {
  const state = await installFixture(page, false);
  state.authGate = deferred();
  state.hiddenSlugs.add('nav-a');
  await page.goto('/');
  await expect.poll(() => state.authReads).toBe(0);
  await page.waitForTimeout(600);
  await expect(page.locator('header,footer')).toHaveCount(0);
  await expect(page.getByText('Navigation content nav-a', { exact: true })).toHaveCount(0);
  expect(state.pageReads).toEqual([]);
  state.authGate.release();
  await expect(page.getByText('Navigation content nav-a', { exact: true })).toBeVisible();
  await expect(page.locator('header,footer')).toHaveCount(0);
});

test('early microsite branding cannot expose a destination before catalogue policy', async ({ page }) => {
  const state = await installFixture(page, false);
  state.catalogueGate = deferred();
  state.hiddenSlugs.add('nav-a');
  await page.goto('/branch/nav-a');
  await expect.poll(() => state.pageReads.length).toBe(1);
  await page.waitForTimeout(600);
  await expect(page.locator('header,footer')).toHaveCount(0);
  await expect(page.getByText('Navigation content nav-a', { exact: true })).toHaveCount(0);
  state.catalogueGate.release();
  await expect(page.getByText('Navigation content nav-a', { exact: true })).toBeVisible();
  await expect(page.locator('header,footer')).toHaveCount(0);
  expect(state.pageReads).toEqual(['nav-a']);
});

test('homepage settings failures stay explicit rather than falling through to events', async ({ page }) => {
  const state = await installFixture(page, false);
  state.settingsFailure = true;
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Homepage unavailable' })).toBeVisible();
  expect(state.pageReads).toEqual([]);
  await expect(page.locator('header,footer')).toHaveCount(0);
});

// Run before and after the application patch, sequentially, on the same
// server/build mode. All API traffic remains intercepted, including writes.
for (const entry of ['/', '/nav-a', '/branch', '/branch/nav-a']) {
  test(`first-content critical path ${entry}`, async ({ browser }) => {
    test.setTimeout(120_000);
    const samples = [];
    for (let sample = 0; sample < 3; sample += 1) {
      const context = await browser.newContext({ hasTouch: true, viewport: { width: 390, height: 844 } });
      const page = await context.newPage();
      const state = await installFixture(page, false);
      await page.addInitScript(() => {
        let previous = null;
        new MutationObserver(() => {
          const paragraph = [...document.querySelectorAll('p')]
            .find(node => /^Navigation content nav-[ab]$/.test(node.textContent));
          if (!paragraph?.checkVisibility({ visibilityProperty: true, opacityProperty: true })) return;
          const text = paragraph?.textContent;
          if (!text || text === previous) return;
          previous = text;
          requestAnimationFrame(() => requestAnimationFrame(() => {
            window.firstContentPaint = { text, at: performance.timeOrigin + performance.now() };
          }));
        }).observe(document, { childList: true, subtree: true, characterData: true, attributes: true });
      });
      Object.assign(state, { firstContentTiming: true, timingFixture: true, timeline: [], started: Date.now(), delayMs: 500 });
      const waitContent = async slug => {
        await expect(page.getByText(`Navigation content ${slug}`, { exact: true })).toBeVisible();
        await page.waitForFunction(text => window.firstContentPaint?.text === text, `Navigation content ${slug}`);
        // Timestamp the DOM/frames themselves, not Playwright assertion polling.
        return Math.round(await page.evaluate(() => window.firstContentPaint.at) - state.started);
      };
      await page.goto(`${origin}${entry}`);
      const cold = await waitContent('nav-a');
      const timeline = [...state.timeline];
      await page.waitForTimeout(400);
      state.started = Date.now();
      await page.getByRole('link', { name: 'Browse next page', exact: true }).tap();
      const touch = await waitContent('nav-b');
      await page.waitForTimeout(400);
      state.started = Date.now();
      await page.goBack();
      const history = await waitContent('nav-a');
      await page.waitForTimeout(400);
      state.started = Date.now();
      // A programmatic click supplies no mouseover or keyboard focus intent.
      await page.getByRole('link', { name: 'Browse next page', exact: true }).evaluate(node => node.click());
      const warm = await waitContent('nav-b');
      expect(state.writes).toEqual([]);
      expect(state.authReads).toBe(1);
      expect(state.documents).toBe(1);
      samples.push({ cold, touch, history, warm, pages: state.pageReads, timeline });
      await context.close();
    }
    console.log('FIRST_CONTENT', JSON.stringify({ phase: process.env.FIRST_CONTENT_PHASE || 'candidate', entry, samples }));
  });
}
async function headerGeometry(page) {
  return page.locator('header').evaluate(node => {
    const bounds = node.getBoundingClientRect();
    return { top: bounds.top, height: bounds.height };
  });
}
async function expectNaturalPending(page, geometry) {
  await expect(page.getByRole('status')).toHaveText('Opening page');
  await expect(page.getByRole('status')).toHaveClass('sr-only');
  const bounds = await page.getByRole('status').boundingBox();
  expect(bounds.height).toBeLessThanOrEqual(1);
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0);
  await expect(page.getByText('Loading page…', { exact: true })).toHaveCount(0);
  await expect(page.locator('[data-testid^="loading-"] [aria-hidden="true"]')).toHaveCount(0);
  expect(await headerGeometry(page)).toEqual(geometry);
}
for (const prefix of ['', '/branch']) {
  test(`controlled intent timing ${prefix || 'main'}`, async ({ page }) => {
    const state = await installFixture(page, false);
    state.timingFixture = true;
    if (process.env.NAV_TIMING_PHASE === 'control') {
      // Same app and fixture, with only pointer intent delivery suppressed.
      // Clicks, route gates, auth and rendering are unchanged by this control.
      await page.addInitScript(() => document.addEventListener('pointerover', event => event.stopImmediatePropagation(), true));
    }
    const samples = [];
    for (let sample = 0; sample < 3; sample += 1) {
      state.delayMs = 0;
      await page.goto(`${prefix}/nav-a`);
      await expect(page.getByText('Navigation content nav-a', { exact: true })).toBeVisible();
      state.delayMs = 800;
      const reads = state.pageReads.length;
      await page.getByRole('link', { name: 'Browse next page', exact: true }).hover();
      await page.waitForTimeout(600);
      const duration = await page.evaluate(() => new Promise(resolve => {
        const start = performance.now();
        const observer = new MutationObserver(() => {
          if (![...document.querySelectorAll('p')].some(node => node.textContent === 'Navigation content nav-b')) return;
          observer.disconnect();
          requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - start)));
        });
        observer.observe(document.querySelector('#root'), { subtree: true, childList: true });
        [...document.querySelectorAll('a')].find(node => node.textContent === 'Browse next page').click();
      }));
      samples.push(Math.round(duration));
      expect(state.pageReads.length).toBe(reads + 1);
    }
    console.log(`CONTROLLED_INTENT_TIMING ${JSON.stringify({ phase: process.env.NAV_TIMING_PHASE || 'candidate', prefix: prefix || 'main', delayMs: 800, dwellMs: 600, clickToRealContentMs: samples })}`);
    if (!['baseline', 'control'].includes(process.env.NAV_TIMING_PHASE)) expect(Math.max(...samples)).toBeLessThan(650);
    if (process.env.NAV_TIMING_PHASE === 'control') expect(Math.min(...samples)).toBeGreaterThanOrEqual(800);
  });
}
for (const prefix of ['', '/branch']) {
  test(`cold public entry has no visible placeholder, skeleton, or speculative chrome ${prefix || 'main'}`, async ({ page }) => {
    const state = await installFixture(page, false);
    state.gate = deferred();
    await page.goto(`${prefix}/nav-hidden`);
    await expect(page.getByRole('status')).toContainText('Loading page');
    await expect(page.getByRole('status').locator('..')).toHaveClass('sr-only');
    expect((await page.getByRole('status').locator('..').boundingBox()).height).toBeLessThanOrEqual(1);
    await expect(page.locator('header,footer')).toHaveCount(0);
    await expect(page.locator('[data-testid^="loading-"] [aria-hidden="true"]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0);
    state.gate.release();
    await expect(page.getByText('Navigation content nav-hidden', { exact: true })).toBeVisible();
    await expect(page.locator('header,footer')).toHaveCount(0);
  });
}

test('fresh A-B-A hidden policy overrides cached projection without any excluded chrome insertion', async ({ page }) => {
  const state = await installFixture(page, false);
  await page.goto('/nav-a');
  await expect(page.getByText('Navigation content nav-a', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Browse next page', exact: true }).click();
  await expect(page.getByText('Navigation content nav-b', { exact: true })).toBeVisible();
  state.hiddenSlugs.add('nav-a');
  await page.evaluate(() => {
    window.cachedChromeInsertions = 0;
    new MutationObserver(records => {
      if (location.pathname !== '/nav-a') return;
      for (const record of records) for (const node of record.addedNodes) {
        if (node.nodeType === 1 && (node.matches('header,footer') || node.querySelector('header,footer'))) window.cachedChromeInsertions += 1;
      }
    }).observe(document.querySelector('#root'), { subtree: true, childList: true });
  });
  state.gate = deferred();
  const geometry = await headerGeometry(page);
  await page.getByRole('link', { name: 'Browse next page', exact: true }).click();
  await expectNaturalPending(page, geometry);
  state.gate.release();
  await expect(page.getByText('Navigation content nav-a', { exact: true })).toBeVisible();
  await expect(page.locator('header,footer')).toHaveCount(0);
  expect(await page.evaluate(() => window.cachedChromeInsertions)).toBe(0);
  expect(state.pageReads).toEqual(['nav-a', 'nav-b', 'nav-a']);
  expect(state.documents).toBe(1);
});

test('keyboard intent and repeated activation share one transport without visible pending UI or header shift', async ({ page }) => {
  const state = await installFixture(page, false);
  await page.goto('/nav-a');
  await expect(page.getByText('Navigation content nav-a', { exact: true })).toBeVisible();
  const geometry = await headerGeometry(page);
  const reads = state.pageReads.length;
  state.gate = deferred();
  const next = page.getByRole('link', { name: 'Browse next page', exact: true });
  await next.focus();
  await expect.poll(() => state.pageReads.length).toBe(reads + 1);
  await expect(page.getByRole('status'), 'mere focus does not announce an operation').toHaveCount(0);
  await next.evaluate(anchor => { anchor.click(); anchor.click(); });
  await expectNaturalPending(page, geometry);
  expect(state.pageReads.length).toBe(reads + 1);
  state.gate.release();
  await expect(page.getByText('Navigation content nav-b', { exact: true })).toBeVisible();
  expect(state.pageReads.length).toBe(reads + 1);
  expect(state.documents).toBe(1);
  expect(state.authReads).toBe(1);
  expect(state.maximumActivePages).toBeLessThanOrEqual(2);
});

test('rapid hover targets are bounded and same-slug cross-prefix clicks cannot consume the wrong site', async ({ page }) => {
  const state = await installFixture(page, false);
  await page.goto('/nav-a');
  await expect(page.getByText('Navigation content nav-a', { exact: true })).toBeVisible();
  state.gate = deferred();
  const reads = state.pageReads.length;
  const names = ['Browse next page', 'Browse branch page', 'Browse other page'];
  for (let index = 0; index < names.length; index += 1) {
    await page.getByRole('link', { name: names[index], exact: true }).hover();
    await expect.poll(() => state.pageReads.length).toBe(reads + index + 1);
  }
  const geometry = await headerGeometry(page);
  await page.getByRole('link', { name: 'Browse other page', exact: true }).evaluate(anchor => anchor.click());
  await expectNaturalPending(page, geometry);
  expect(state.pageScopes.slice(reads)).toEqual([null, 'branch', 'other']);
  expect(state.maximumActivePages).toBeLessThanOrEqual(2);
  state.gate.release();
  await expect(page).toHaveURL(/\/other\/nav-b$/);
  await expect(page.getByText('Navigation scope other', { exact: true })).toBeVisible();
  await expect(page.getByText('Navigation scope branch', { exact: true })).toHaveCount(0);
  expect(state.pageReads.length).toBe(reads + 3);
  expect(state.documents).toBe(1);
});

test('logout storage transition aborts hovered member transport and fences late member-only content', async ({ page }) => {
  const state = await installFixture(page, true);
  await page.goto('/nav-a');
  await expect(page.getByText('Member audience secret', { exact: true })).toBeVisible();
  state.gate = deferred();
  const reads = state.pageReads.length;
  const authReads = state.authReads;
  await page.getByRole('link', { name: 'Browse next page', exact: true }).focus();
  await expect.poll(() => state.pageReads.length).toBe(reads + 1);
  state.authenticated = false;
  await page.evaluate(member => {
    const oldValue = JSON.stringify(member);
    localStorage.removeItem('agcas_member');
    dispatchEvent(new StorageEvent('storage', { key: 'agcas_member', oldValue, newValue: null }));
  }, member);
  await expect.poll(() => state.authReads).toBeGreaterThan(authReads);
  await expect(page.getByText('Member audience secret', { exact: true })).toHaveCount(0);
  state.gate.release();
  state.gate = null;
  await expect(page.getByText('Navigation content nav-a', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/nav-a$/);
  await page.getByRole('link', { name: 'Browse next page', exact: true }).click();
  await expect(page.getByText('Navigation content nav-b', { exact: true })).toBeVisible();
  await expect(page.getByText('Member audience secret', { exact: true })).toHaveCount(0);
  expect(state.pageReads.filter(slug => slug === 'nav-b')).toHaveLength(2);
  expect(state.documents).toBe(1);
  expect(state.writes).toEqual([]);
});

for (const authenticated of [false, true]) {
  for (const prefix of ['', '/branch']) {
    test(`${authenticated ? 'member' : 'guest'} ${prefix || 'main'} A-B-A, hidden destination, and error continuity`, async ({ page }) => {
      const state = await installFixture(page, authenticated);
      await page.goto(`${prefix}/nav-a`);
      await expect(page.getByText('Navigation content nav-a', { exact: true })).toBeVisible();
      await page.evaluate(() => {
        window.hiddenChromeMounts = 0;
        new MutationObserver(records => {
          if (!location.pathname.endsWith('/nav-hidden')) return;
          for (const record of records) for (const node of record.addedNodes) {
            if (node.nodeType === 1 && (node.matches('header,footer') || node.querySelector('header,footer'))) {
              window.hiddenChromeMounts += 1;
            }
          }
        }).observe(document.querySelector('#root'), { childList: true, subtree: true });
      });
      await page.evaluate(() => { window.navigationHeader = document.querySelector('header'); });
      const documents = state.documents;
      const authReads = state.authReads;
      for (const slug of ['nav-b', 'nav-a']) {
        await page.evaluate(() => { window.navigationHeader = document.querySelector('header'); });
        const geometry = await headerGeometry(page);
        state.gate = deferred();
        const reads = state.pageReads.length;
        await page.getByRole('link', { name: 'Browse next page', exact: true }).click();
        await expect.poll(() => state.pageReads.length).toBe(reads + 1);
        await expectNaturalPending(page, geometry);
        await expect(page).toHaveURL(new RegExp(`${prefix}/${slug === 'nav-b' ? 'nav-a' : 'nav-b'}$`));
        expect(await page.evaluate(() => window.navigationHeader === document.querySelector('header'))).toBe(true);
        state.gate.release();
        await expect(page.getByText(`Navigation content ${slug}`, { exact: true })).toBeVisible();
        await expect(page).toHaveURL(new RegExp(`${prefix}/${slug}$`));
        expect(state.pageReads.length).toBe(reads + 1, 'single navigation request, including no-store A return');
        // The projection query is stale and eligible for a reconnect refresh.
        // Its background activity must not recreate the public content parent.
        await page.evaluate(() => {
          document.querySelectorAll('input[aria-label="Navigation draft"]').forEach(input => input.remove());
          const input = document.createElement('input');
          input.setAttribute('aria-label', 'Navigation draft');
          input.value = 'unsaved public draft';
          document.querySelector('main').append(input);
          window.navigationDraft = input;
          dispatchEvent(new Event('offline'));
          dispatchEvent(new Event('online'));
          dispatchEvent(new Event('focus'));
        });
        await expect(page.getByRole('textbox', { name: 'Navigation draft' })).toHaveValue('unsaved public draft');
        expect(await page.evaluate(() => window.navigationDraft === document.querySelector('input[aria-label="Navigation draft"]'))).toBe(true);
      }
      state.gate = deferred();
      const geometry = await headerGeometry(page);
      await page.getByRole('link', { name: 'Browse hidden page', exact: true }).click();
      await expectNaturalPending(page, geometry);
      await expect(page).toHaveURL(new RegExp(`${prefix}/nav-a$`));
      await expect(page.locator('header')).toBeVisible();
      state.gate.release();
      await expect(page.getByText('Navigation content nav-hidden', { exact: true })).toBeVisible();
      await expect(page.locator('header, footer')).toHaveCount(0);
      expect(await page.evaluate(() => window.hiddenChromeMounts)).toBe(0);
      state.gate = null;
      await page.goBack();
      await expect(page.getByText('Navigation content nav-a', { exact: true })).toBeVisible();
      state.fail = true;
      await page.getByRole('link', { name: 'Browse error page', exact: true }).click();
      await expect(page.getByRole('alert')).toContainText('Page unavailable');
      await expect(page.locator('header, footer')).toHaveCount(0);
      expect(state.authReads).toBe(authReads);
      expect(state.documents).toBe(documents);
      expect(state.writes).toEqual([]);
    });
  }
}
