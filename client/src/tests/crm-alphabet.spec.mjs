import { test, expect } from '@playwright/test';
import {
  createListFixture, installListFixture, defaultSavedView,
} from '../../../tests/member-organisation-list-loading.fixtures.mjs';

const configs = [
  { kind: 'organisations', endpoint: 'organizations', size: 20, field: 'name', row: 'row-org-', card: 'card-org-', layout: 'button-view-card' },
  { kind: 'members', endpoint: 'members', size: 50, field: 'first_name', row: 'member-row-', card: 'member-card-', layout: 'button-member-view-card' },
];

async function setup(page, cfg, options = {}) {
  const fixture = createListFixture({ savedView: options.saved
    ? defaultSavedView(cfg.kind, { filters: { searchQuery: '', sortField: cfg.field, sortDir: 'asc' } }) : null });
  fixture.page = cfg.kind;
  await installListFixture(page, fixture);
  const state = { alphabet: [], reads: [], fail: false, delay: 0, missing: false };
  // Explicit fixture DB order, including repeated runs and non-ASCII labels.
  const runs = [['#', 1], ['A', cfg.size], ['B', 2], ['C', 1], ['É', 1], ['A', 1], ['Z', 1107]];
  const rows = [];
  const buckets = runs.map(([label, count]) => {
    const offset = rows.length;
    for (let index = 0; index < count; index++) {
      const id = `alphabet-${rows.length}`;
      rows.push({ ...fixture[cfg.kind === 'members' ? 'members' : 'organisations'][0], id,
        name: `${label} Organisation ${id}`, first_name: `${label} Person`, last_name: id });
    }
    return { label, count, offset, id: rows[offset].id };
  });
  await page.route(`**/api/admin/${cfg.endpoint}/paginated?**`, async route => {
    const query = Object.fromEntries(new URL(route.request().url()).searchParams);
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (query.alphabet) {
      state.alphabet.push(query);
      if (state.fail) return json({ error: 'Fixture unavailable' }, 503);
      return json({ buckets: query.search ? [] : buckets, total: query.search ? 0 : rows.length });
    }
    state.reads.push(query);
    const delay = state.delay;
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    const number = Number(query.page);
    const result = query.search ? [] : rows.slice((number - 1) * cfg.size, number * cfg.size);
    return json({
      [cfg.kind === 'members' ? 'members' : 'organizations']: state.missing ? [] : result,
      pagination: { page: number, limit: cfg.size, total: query.search ? 0 : rows.length, totalPages: Math.ceil(rows.length / cfg.size) },
    });
  });
  return state;
}

for (const cfg of configs) {
  test(`${cfg.kind}: defaults, cross-page/same-page targets, cards, keyboard and independent metadata`, async ({ page }) => {
    const state = await setup(page, cfg);
    await page.goto(`/${cfg.kind}`);
    await expect.poll(() => state.reads.length).toBeGreaterThan(0);
    expect(state.reads[0]).toMatchObject({ limit: String(cfg.size), sortField: cfg.kind === 'members' ? 'created_on' : 'name', sortDir: cfg.kind === 'members' ? 'desc' : 'asc' });
    if (cfg.kind === 'members') {
      await expect(page.getByRole('navigation', { name: 'Alphabet navigation' })).toHaveCount(0);
      await page.getByTestId('select-member-name-sort').selectOption('first_name');
    }
    const nav = page.getByRole('navigation', { name: 'Alphabet navigation' });
    await expect(nav).toBeVisible();
    const metaCount = state.alphabet.length;
    expect(state.alphabet[0]).not.toHaveProperty('page');
    expect(state.alphabet[0]).not.toHaveProperty('fields');
    const group = nav.getByRole('button', { name: 'Jump to B–C, 3 records', exact: true });
    await group.click();
    const id = `alphabet-${1 + cfg.size}`;
    const row = page.getByTestId(`${cfg.row}${id}`);
    await expect(row).toBeFocused();
    await expect(row).toHaveAttribute('data-alphabet-highlighted', 'true');
    await expect(group).toHaveAttribute('aria-current', 'location');
    expect(state.reads.at(-1).page).toBe('2');
    await group.click(); // same-page jump, no state-change-dependent scroll
    await expect(row).toBeFocused();
    await page.getByTestId(cfg.layout).click();
    await group.click();
    await expect(page.getByTestId(`${cfg.card}${id}`)).toBeFocused();
    await page.getByTestId(cfg.kind === 'members' ? 'button-member-next-page' : 'button-next-page').click();
    await expect(page.locator('[data-alphabet-highlighted=true]')).toHaveCount(0);
    expect(state.alphabet).toHaveLength(metaCount);
    await group.focus();
    await page.keyboard.press('Home');
    await expect(nav.getByRole('button').first()).toBeFocused();
    await page.keyboard.press('End');
    await expect(nav.getByRole('button').last()).toBeFocused();
  });

  test(`${cfg.kind}: raw search cancels pending jumps, empty metadata hides bar, failures retry`, async ({ page }) => {
    const state = await setup(page, cfg, { saved: true });
    state.fail = true;
    await page.goto(`/${cfg.kind}`);
    await expect(page.getByRole('button', { name: 'Retry alphabet' })).toBeVisible();
    await expect(page.locator(`[data-testid^="${cfg.row}"]`).first()).toBeVisible();
    state.fail = false;
    await page.getByRole('button', { name: 'Retry alphabet' }).click();
    const nav = page.getByRole('navigation', { name: 'Alphabet navigation' });
    await expect(nav).toBeVisible();
    state.delay = 700;
    await nav.getByRole('button', { name: 'Jump to Z, 1107 records' }).click();
    await page.getByTestId(cfg.kind === 'members' ? 'input-search-members' : 'input-search-orgs').fill('not-found');
    await page.waitForTimeout(1100);
    await expect(nav).toHaveCount(0);
    await expect(page.locator('[data-alphabet-highlighted=true]')).toHaveCount(0);
  });

  test(`${cfg.kind}: rapid reversed jumps and missing records never select another target`, async ({ page }) => {
    const state = await setup(page, cfg, { saved: true });
    await page.goto(`/${cfg.kind}`);
    const nav = page.getByRole('navigation', { name: 'Alphabet navigation' });
    await expect(nav).toBeVisible();
    state.delay = 650;
    await nav.getByRole('button', { name: 'Jump to Z, 1107 records' }).click();
    state.delay = 10;
    await nav.getByRole('button', { name: 'Jump to B–C, 3 records' }).click();
    const id = `alphabet-${1 + cfg.size}`;
    await expect(page.getByTestId(`${cfg.row}${id}`)).toBeFocused();
    await page.waitForTimeout(750);
    await expect(page.getByTestId(`${cfg.row}${id}`)).toHaveAttribute('data-alphabet-highlighted', 'true');
    state.missing = true;
    await nav.getByRole('button', { name: 'Jump to Z, 1107 records' }).click();
    await expect(page.locator('[data-alphabet-highlighted=true]')).toHaveCount(0);
    await expect(page.getByText('This record has moved or is no longer available. Try the alphabet again.')).toBeAttached();
  });

  test(`${cfg.kind}: mobile navigation scrolls horizontally without changing card layout`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await setup(page, cfg, { saved: true });
    await page.goto(`/${cfg.kind}`);
    await page.getByTestId(cfg.kind === 'members' ? 'button-collapse-member-sidebar' : 'button-collapse-sidebar').click();
    const nav = page.getByRole('navigation', { name: 'Alphabet navigation' });
    await expect(nav).toBeVisible();
    await page.getByTestId(cfg.layout).click();
    const bounds = await nav.boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
    await page.screenshot({ path: `test-results/crm-alphabet-${cfg.kind}-mobile.png` });
    await nav.getByRole('button', { name: 'Jump to B–C, 3 records' }).click();
    await expect(page.getByTestId(`${cfg.card}alphabet-${1 + cfg.size}`)).toBeFocused();
    await expect(nav).toHaveCSS('overflow-x', 'auto');
  });
}
