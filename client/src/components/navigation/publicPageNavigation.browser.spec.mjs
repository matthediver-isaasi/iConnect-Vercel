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
          <a href="${path}/nav-error">Browse error page</a></div>` },
      }],
    }] } },
  };
}
async function installFixture(page, authenticated) {
  const state = { documents: 0, authReads: 0, pageReads: [], writes: [], gate: null, fail: false };
  await page.addInitScript(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.context().route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) return route.fulfill({ status: 204, body: '' });
    if (!url.pathname.startsWith('/api/')) {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) state.documents += 1;
      return route.continue();
    }
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json',
      headers: { 'Cache-Control': 'private, no-store' }, body: JSON.stringify(body) });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
      if (request.method() === 'PATCH' && url.pathname === `/api/entities/Member/${member.id}`
        && Object.keys(request.postDataJSON() || {}).join() === 'last_activity') return json(member);
      state.writes.push(`${request.method()} ${url.pathname}`);
      return json({ error: 'Read-only fixture' }, 599);
    }
    if (url.pathname === '/api/auth/me') {
      state.authReads += 1;
      return authenticated ? json({ ...member, sessionRole: { status: 'ready', member_id: member.id,
        tenant_id: member.tenant_id, role_id: role.id, session_key: 'navigation-session', role } })
        : json({ error: 'Not authenticated' }, 401);
    }
    if (url.pathname === '/api/auth/tenant-user-me') return json({ authenticated: false }, 401);
    if (url.pathname === '/api/public/tenant-branding') return json({ success: true, branding: {
      id: member.tenant_id, name: 'Navigation fixture', headerConfig: {}, footerConfig: {},
      platformBranding: { enabled: false },
    } });
    if (url.pathname === '/api/public/portal-branding') return json({ tenantName: 'Navigation fixture', homePageSlug: 'nav-a' });
    if (url.pathname === '/api/public/microsites') return json({ microsites: [micro] });
    if (url.pathname.startsWith('/api/public/page/')) {
      const slug = url.pathname.split('/').pop();
      state.pageReads.push(slug);
      const gate = state.gate;
      const fail = state.fail;
      if (gate) await gate.promise;
      if (fail) return json({ error: 'Fixture unavailable' }, 503);
      return json({ success: true, page: pageRecord(slug, url.searchParams.get('microsite')), elements: [], symbols: [] });
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
        state.gate = deferred();
        const reads = state.pageReads.length;
        await page.getByRole('link', { name: 'Browse next page', exact: true }).click();
        await expect.poll(() => state.pageReads.length).toBe(reads + 1);
        await expect(page.getByRole('status')).toContainText('Loading page');
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
      await page.getByRole('link', { name: 'Browse hidden page', exact: true }).click();
      await expect(page.getByRole('status')).toContainText('Loading page');
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
