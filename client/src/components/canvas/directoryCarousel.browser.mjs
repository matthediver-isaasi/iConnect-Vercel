import { test, expect } from '@playwright/test';

const slug = 'directory-carousel-task5186-fixture';
const member = { id: 'viewer5186', first_name: 'Alex', last_name: 'Mercer', tenant_id: 'tenant5186', role_id: 'role5186', is_team_member: true };
const role = { id: member.role_id, name: 'Canvas administrator', excluded_features: [] };

async function fixture(page, content, { denied = false, records, directories, guest = false, entityType, allowSave = false, delaySource, delayNameDisplay, inheritNames = true } = {}) {
  page.on('pageerror', (error) => console.error('Fixture page error:', error.message));
  const requests = [];
  const writes = [];
  const saved = [];
  const authRequests = [];
  const pending = [];
  const block = {
    id: 'carousel5186', type: 'directory-carousel', name: 'Directory carousel',
    geom: { x: 0, y: 0, w: 1200, h: 420 },
    bp: { desktop: { x: 0, y: 0, w: 1200, h: 420 }, mobile: { x: 0, y: 0, w: 375, h: 360 } },
    style: { background: '#f8fafc', borderWidth: 2, borderColor: '#64748b', borderRadius: 12 },
    content: { perView: { desktop: 3, tablet: 2, mobile: 1 }, showDetails: true, autoplay: false, ...content },
  };
  const fixturePage = {
    id: 'page5186', slug, title: 'Directory carousel fixture', status: 'published',
    builder_type: 'canvas', layout_type: 'public', public_chrome: 'none', tenant_id: member.tenant_id,
    canvas_design: { version: 1, root: { groups: [], guides: { vertical: [], horizontal: [] }, sections: [{ id: 'section5186', children: [block] }] } },
  };
  await page.addInitScript(({ viewer, guest }) => {
    if (guest) localStorage.removeItem('agcas_member');
    else localStorage.setItem('agcas_member', JSON.stringify(viewer));
    localStorage.setItem('tenant_slug', 'carousel5186');
  }, { viewer: member, guest });
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!url.pathname.startsWith('/api/')) return route.continue();
    if (request.method() !== 'GET') {
      if (url.pathname.startsWith('/api/canvas-page-audits/')) return json(route, { audit: {} });
      if (url.pathname.startsWith('/api/canvas-versions/')) return json(route, { version: {} });
      if (allowSave && request.method() === 'PUT' && url.pathname === '/api/canvas-design/page5186') {
        const body = request.postDataJSON();
        saved.push(body);
        fixturePage.canvas_design = body.canvas_design;
        return json(route, { page: fixturePage });
      }
      writes.push(url.pathname);
      return json(route, { error: 'Fixture writes prohibited' }, 405);
    }
    if (url.pathname === '/api/auth/me') {
      authRequests.push(url.pathname);
      return json(route, guest ? { error: 'Not authenticated' } : member, guest ? 401 : 200);
    }
    if (url.pathname === '/api/auth/tenant-user-me') {
      authRequests.push(url.pathname);
      if (guest) return json(route, { authenticated: false, tenantUser: null, member: null }, 401);
      return json(route, {
      authenticated: true, member, user: member, tenantId: member.tenant_id, memberId: member.id,
      tenant: { id: member.tenant_id, slug: 'carousel5186' },
      tenantUser: { id: 'admin5186', role, tenant: { id: member.tenant_id, slug: 'carousel5186' } },
      });
    }
    if (url.pathname === `/api/entities/Role/${role.id}`) return json(route, role);
    if (url.pathname === `/api/entities/Member/${member.id}`) return json(route, member);
    if (url.pathname === '/api/entities/DynamicDirectory') {
      const all = directories || [];
      const offset = Number(url.searchParams.get('offset') || 0);
      const limit = Number(url.searchParams.get('limit') || 100);
      return json(route, all.slice(offset, offset + limit));
    }
    if (url.pathname === '/api/entities/IEditPage') return json(route, [fixturePage]);
    if (url.pathname === '/api/canvas-design/page5186') return json(route, { page: fixturePage });
    if (url.pathname === `/api/public/page/${slug}`) return json(route, { success: true, page: fixturePage, elements: [], symbols: [] });
    if (url.pathname === '/api/public/dynamic-directory') {
      requests.push(Object.fromEntries(url.searchParams));
      if (delaySource && url.searchParams.get('source') === delaySource) {
        await new Promise((resolve) => pending.push(resolve));
      }
      const nameDisplay = url.searchParams.get('organization_name_display') || 'inherit';
      if (delayNameDisplay && nameDisplay === delayNameDisplay) {
        await new Promise((resolve) => pending.push(resolve));
      }
      if (denied) return json(route, { error: 'Private directory metadata must not leak' }, 403);
      const type = entityType || (url.searchParams.get('source') === 'primary-member' ? 'member' : 'organization');
      const entries = (records || Array.from({ length: 5 }, (_, i) => ({
        id: `${type}-${i}`, name: `${type === 'member' ? 'Member' : 'Organisation'} ${i + 1}`,
        profile_photo_url: null, logo_url: null, job_title: type === 'member' ? 'Programme coordinator' : null,
      }))).map((entry) => type === 'organization' && (nameDisplay === 'hide' || (nameDisplay === 'inherit' && !inheritNames))
        ? { ...entry, name: null }
        : entry);
      const size = Number(url.searchParams.get('limit') || 3);
      const current = Number(url.searchParams.get('page') || 1);
      return json(route, { entityType: type, records: entries.slice((current - 1) * size, current * size), total: entries.length, page: current, pageSize: size });
    }
    return json(route, url.pathname.includes('/branding') || url.pathname.includes('/settings') ? { tenant: { id: member.tenant_id }, branding: {} } : []);
  });
  return { requests, writes, saved, authRequests, block, release() { while (pending.length) pending.shift()(); } };
}

for (const [source, entityType] of [['primary-member', 'member'], ['primary-organization', 'organization'], ['dynamic', 'member'], ['dynamic', 'organization']]) {
  test(`${source}/${entityType}: explicit identity, partial pages, details and simulated mobile`, async ({ page }) => {
    const state = await fixture(page, {
      source, directoryId: source === 'dynamic' ? 'stable-directory-id' : '', directorySlug: 'stale-legacy-slug',
      randomiseOrder: true,
    }, { entityType });
    await page.goto(`/${slug}`);
    const carousel = page.getByTestId('directory-carousel');
    await expect(carousel).toBeVisible();
    await expect.poll(() => state.requests.at(-1)?.source).toBe(source);
    const first = state.requests.at(-1);
    expect(first.organization_name_display).toBe('inherit');
    expect(first.slug).toBeUndefined();
    expect(first.directory_id).toBe(source === 'dynamic' ? 'stable-directory-id' : undefined);
    expect(first.seed).toBeTruthy();
    await expect(carousel.getByText(entityType === 'member' ? 'Member 1' : 'Organisation 1', { exact: true })).toBeVisible();
    await carousel.getByTestId('button-directory-carousel-next').click();
    await expect(carousel.getByTestId('directory-carousel-page-status')).toContainText('Page 2 of 2');
    await expect(carousel.locator("button[aria-label^='View details for']")).toHaveCount(2);
    await carousel.locator("button[aria-label^='View details for']").first().click();
    await expect(page.getByTestId('dialog-directory-carousel-detail')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(carousel.locator("button[aria-label^='View details for']")).toHaveCount(1);
    expect(state.requests.at(-1).seed).toBe(first.seed);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    // Device preview is authoritative even inside a desktop-sized viewport.
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`/${slug}?_bp=mobile`);
    await expect(page.getByTestId('directory-carousel').locator("button[aria-label^='View details for']")).toHaveCount(1);
    expect(state.requests.at(-1).seed).not.toBe(first.seed);
    expect(state.writes).toEqual([]);
  });
}

test('denied source is metadata-safe and does not retry on focus or resize', async ({ page }) => {
  const state = await fixture(page, { source: 'primary-member' }, { denied: true, guest: true });
  await page.goto(`/${slug}`);
  await expect(page.getByText('This directory is not available to this visitor.')).toBeVisible();
  await expect(page.getByText('Private directory metadata must not leak')).toHaveCount(0);
  const count = state.requests.length;
  await page.evaluate(() => { dispatchEvent(new Event('focus')); dispatchEvent(new Event('online')); });
  await page.waitForTimeout(800);
  expect(state.requests.length).toBe(count);
  expect(await page.evaluate(() => localStorage.getItem('agcas_member'))).toBeNull();
  expect(state.authRequests.length).toBeGreaterThan(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => state.requests.at(-1)?.limit).toBe('1');
  const resizedCount = state.requests.length;
  await page.waitForTimeout(1500);
  expect(state.requests.length).toBe(resizedCount);
  expect(state.writes).toEqual([]);
});

test('source replacement immediately clears selected details and cards before the new response', async ({ page }) => {
  const state = await fixture(page, { source: 'primary-organization' }, { delaySource: 'primary-member' });
  await page.goto(`/${slug}`);
  await expect(page.getByTestId('directory-carousel')).toBeVisible();
  await page.evaluate(async (block) => {
    const { mountDirectoryCarouselTest } = await import('/src/components/canvas/blocks/DirectoryCarousel.browserHarness.jsx');
    const host = document.createElement('div');
    host.id = 'isolated-carousel';
    host.style.cssText = 'position:fixed;inset:0;background:#f8fafc;z-index:9999;padding:16px';
    document.body.append(host);
    window.carouselTest = mountDirectoryCarouselTest(host, block);
  }, state.block);
  const surface = page.locator('#isolated-carousel');
  await expect(surface.getByText('Organisation 1', { exact: true })).toBeVisible();
  await surface.getByTestId('button-directory-carousel-next').click();
  await expect(surface.getByTestId('directory-carousel-page-status')).toContainText('Page 2 of 2');
  await surface.getByRole('button', { name: 'View details for Organisation 4' }).click();
  await expect(page.getByTestId('dialog-directory-carousel-detail')).toBeVisible();
  await page.evaluate(() => window.carouselTest.changeContent({ source: 'primary-member', directoryId: '', directorySlug: '' }));
  await expect(page.getByTestId('dialog-directory-carousel-detail')).toHaveCount(0);
  await expect(surface.getByText(/Organisation [1-5]/)).toHaveCount(0);
  await expect.poll(() => state.requests.at(-1)?.source).toBe('primary-member');
  expect(state.requests.at(-1).page).toBe('1');
  state.release();
  await expect(surface.getByText('Member 1', { exact: true })).toBeVisible();
  await expect(surface.getByTestId('directory-carousel-page-status')).toContainText('Page 1 of 2');
  await page.evaluate(() => window.carouselTest.unmount());
});

test('editor persists and reopens independent presentation controls and shared appearance', async ({ page }) => {
  const state = await fixture(page, { source: 'primary-member', randomiseOrder: true }, { allowSave: true });
  await page.goto('/CanvasPageEditor?pageId=page5186');
  await page.getByTestId('canvas-block-carousel5186').click();
  await expect(page.getByTestId('select-directory-carousel-organisation-name-display')).toContainText('Use directory setting');
  await page.getByTestId('select-directory-carousel-organisation-name-display').click();
  await page.getByRole('option', { name: 'Hide', exact: true }).click();
  for (const [device, count, height, gap, padding, nameSize, descSize] of [
    ['desktop', '4', '460', '21', '25', '23', '15'],
    ['tablet', '2', '410', '15', '18', '20', '14'],
    ['mobile', '1', '350', '9', '12', '18', '13'],
  ]) {
    await page.getByTestId(`button-breakpoint-${device}`).click();
    await page.getByTestId('input-directory-carousel-per-view').fill(count);
    await page.getByTestId('input-directory-carousel-height').fill(height);
    await page.getByTestId('input-directory-carousel-gap').fill(gap);
    for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
      await page.getByTestId(`input-directory-carousel-innerPadding${side}`).fill(padding);
    }
    await page.getByTestId('input-directory-carousel-name-font-size').fill(nameSize);
    await page.getByTestId('input-directory-carousel-desc-font-size').fill(descSize);
  }
  await expect(page.getByText('Stage full width', { exact: true })).toBeVisible();
  await page.getByTestId('button-toggle-full-width').click();
  await page.getByTestId('toggle-directory-carousel-full-bleed').click();
  await page.getByTestId('input-border-width').fill('3');
  await page.getByTestId('input-border-radius').fill('17');
  await page.getByTestId('input-bg-color').evaluate((input) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, '#e4edf2');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.getByTestId('input-border-color').evaluate((input) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, '#526b7d');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(page.getByTestId('input-padding-top')).toHaveCount(0);
  await page.getByTestId('button-save').click();
  await expect.poll(() => state.saved.length).toBeGreaterThan(0);
  const savedBlock = state.saved.at(-1).canvas_design.root.sections[0].children[0];
  expect(savedBlock.content.organisationNameDisplay).toBe('hide');
  expect(savedBlock.content.perView).toEqual({ desktop: 4, tablet: 2, mobile: 1 });
  expect(savedBlock.content.gap).toEqual({ desktop: 21, tablet: 15, mobile: 9 });
  expect(savedBlock.content.nameFontSize).toEqual({ desktop: 23, tablet: 20, mobile: 18 });
  expect(savedBlock.content.descFontSize).toEqual({ desktop: 15, tablet: 14, mobile: 13 });
  for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
    expect(savedBlock.content[`innerPadding${side}`]).toEqual({ desktop: 25, tablet: 18, mobile: 12 });
  }
  expect(savedBlock.fullWidth).toBe(true);
  expect(savedBlock.content.fullBleed).toBe(true);
  expect(savedBlock.style).toEqual(expect.objectContaining({ background: '#e4edf2', borderColor: '#526b7d', borderWidth: 3, borderRadius: 17 }));
  expect(savedBlock.bp.desktop.h).toBe(460);
  expect(savedBlock.bp.tablet.h).toBe(410);
  expect(savedBlock.bp.mobile.h).toBe(350);
  await page.reload();
  await page.getByTestId('canvas-block-carousel5186').click();
  await expect(page.getByTestId('select-directory-carousel-organisation-name-display')).toContainText('Hide');
  await page.getByTestId('button-breakpoint-mobile').click();
  await expect(page.getByTestId('input-directory-carousel-per-view')).toHaveValue('1');
  await expect(page.getByTestId('input-directory-carousel-height')).toHaveValue('350');
  await expect(page.getByTestId('input-directory-carousel-gap')).toHaveValue('9');
  await page.goto(`/${slug}?_bp=mobile`);
  const carousel = page.getByTestId('directory-carousel');
  await expect(carousel.locator("button[aria-label^='View details for']")).toHaveCount(1);
  const wrapper = page.locator('[data-cb="carousel5186"]');
  await expect(wrapper).toHaveCSS('height', '350px');
  await expect(wrapper).toHaveCSS('background-color', 'rgb(228, 237, 242)');
  await expect(wrapper).toHaveCSS('border-top-width', '3px');
  await expect(carousel.getByTestId('text-directory-carousel-name-member-0')).toHaveCSS('font-size', '18px');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(state.writes).toEqual([]);
});

for (const [mode, inherited, visible] of [
  ['show', false, true],
  ['hide', true, false],
  ['inherit', true, true],
  ['inherit', false, false],
]) {
  test(`organisation names: ${mode}, directory names ${inherited ? 'shown' : 'hidden'}`, async ({ page }) => {
    const state = await fixture(page, { source: 'primary-organization', organisationNameDisplay: mode }, { inheritNames: inherited });
    await page.goto(`/${slug}`);
    const carousel = page.getByTestId('directory-carousel');
    await expect(carousel).toBeVisible();
    await expect.poll(() => state.requests.at(-1)?.organization_name_display).toBe(mode);
    const names = carousel.locator('[data-testid^="text-directory-carousel-name-"]');
    await expect(names).toHaveCount(visible ? 3 : 0);
    if (visible) {
      await expect(names.first()).toHaveCSS('text-align', 'center');
    } else {
      await expect(carousel.getByRole('button', { name: 'View details for organisation', exact: true })).toHaveCount(3);
      await expect(carousel.getByText('Organisation', { exact: true })).toHaveCount(0);
    }
    expect(state.writes).toEqual([]);
  });
}

test('name display replacement clears cards and open details while the new projection is pending', async ({ page }) => {
  const state = await fixture(page, { source: 'primary-organization', organisationNameDisplay: 'show' }, { delayNameDisplay: 'hide', inheritNames: false });
  await page.goto(`/${slug}`);
  await expect(page.getByTestId('directory-carousel')).toBeVisible();
  await page.evaluate(async (block) => {
    const { mountDirectoryCarouselTest } = await import('/src/components/canvas/blocks/DirectoryCarousel.browserHarness.jsx');
    const host = document.createElement('div');
    host.id = 'isolated-carousel';
    host.style.cssText = 'position:fixed;inset:0;background:#f8fafc;z-index:9999;padding:16px';
    document.body.append(host);
    window.carouselTest = mountDirectoryCarouselTest(host, block);
  }, state.block);
  const surface = page.locator('#isolated-carousel');
  await expect(surface.getByText('Organisation 1', { exact: true })).toBeVisible();
  await surface.getByTestId('button-directory-carousel-next').click();
  await surface.getByRole('button', { name: 'View details for Organisation 4', exact: true }).click();
  await expect(page.getByTestId('dialog-directory-carousel-detail')).toBeVisible();
  await page.evaluate(() => window.carouselTest.changeContent({ organisationNameDisplay: 'hide' }));
  await expect(page.getByTestId('dialog-directory-carousel-detail')).toHaveCount(0);
  await expect(surface.getByText(/Organisation [1-5]/)).toHaveCount(0);
  await expect.poll(() => state.requests.at(-1)?.organization_name_display).toBe('hide');
  expect(state.requests.at(-1).page).toBe('1');
  state.release();
  await expect(surface.getByTestId('button-directory-carousel-organization-0')).toBeVisible();
  await expect(surface.locator('[data-testid^="text-directory-carousel-name-"]')).toHaveCount(0);
  // Inherit is a separate request/cache identity, even when the resulting
  // directory projection also withholds names.
  await page.evaluate(() => window.carouselTest.changeContent({ organisationNameDisplay: 'inherit' }));
  await expect.poll(() => state.requests.at(-1)?.organization_name_display).toBe('inherit');
  await expect(surface.getByTestId('button-directory-carousel-organization-0')).toBeVisible();
  await expect(surface.locator('[data-testid^="text-directory-carousel-name-"]')).toHaveCount(0);
  await page.evaluate(() => window.carouselTest.changeContent({ organisationNameDisplay: 'show' }));
  await expect(surface.getByText('Organisation 1', { exact: true })).toBeVisible();
  await expect(surface.getByTestId('directory-carousel-page-status')).toContainText('Page 1 of 2');
  await page.evaluate(() => window.carouselTest.unmount());
  expect(state.writes).toEqual([]);
});

test('searchable source discovery includes member and organisation directories beyond 100', async ({ page }) => {
  const directories = Array.from({ length: 137 }, (_, i) => ({
    id: `directory-${i}`, slug: `directory-${i}`, name: i === 136 ? 'Westhaven Professional Network' : `Association directory ${i}`,
    entity_type: i % 2 ? 'member' : 'organization', is_active: true,
  }));
  await fixture(page, { directorySlug: 'directory-0' }, { directories });
  await page.goto('/CanvasPageEditor?pageId=page5186');
  await page.getByTestId('canvas-block-carousel5186').click();
  await page.getByTestId('select-directory-carousel-directory').click();
  await page.getByPlaceholder('Search member or organisation directories…').fill('Westhaven');
  await page.getByRole('option', { name: /Westhaven Professional Network/ }).click();
  await expect(page.getByTestId('select-directory-carousel-directory')).toContainText('Westhaven');
});
