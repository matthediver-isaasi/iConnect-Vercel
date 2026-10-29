import { test, expect } from '@playwright/test';

async function fixture(page, { count = 31, restricted = false, fail = false } = {}) {
  const state = { calls: [], writes: [], fail, members: Array.from({ length: count }, (_, i) => ({
    id: `m${String(i).padStart(4, '0')}`, organization_id: 'org',
    first_name: `Person${String(i).padStart(4, '0')}`, last_name: `Surname${String(count - i).padStart(4, '0')}`,
    email: `person${i}@example.invalid`, role_id: i % 2 ? 'role-b' : 'role-a',
    created_on: i === 2 ? 'bad' : `202${i % 5}-01-02T00:00:00Z`,
    last_activity: i === 0 ? null : i === 1 ? 'bad' : '2026-01-04T12:00:00Z',
    login_enabled: i !== 3,
  })) };
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://127.0.0.1:5197') return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const json = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    if (route.request().method() !== 'GET') {
      state.writes.push(url.pathname);
      return json({ error: 'Fixture forbids mutations' }, 403);
    }
    if (url.pathname === '/api/entities/Member') {
      const offset = Number(url.searchParams.get('offset') || 0);
      state.calls.push({ offset, sort: JSON.parse(url.searchParams.get('sort')), filter: JSON.parse(url.searchParams.get('filter')) });
      if (state.fail && offset > 0) return json({ error: 'Synthetic batch failure' }, 500);
      return json({ data: state.members.slice(offset, offset + 500), count: state.members.length });
    }
    if (url.pathname === '/api/entities/Role') return json([
      { id: 'role-a', name: 'Alpha', is_active: true },
      { id: 'role-b', name: 'Zulu', requires_effective_from_date: true, is_active: true },
    ]);
    if (url.pathname === '/api/entities/Organization/org') return json({ id: 'org' });
    if (url.pathname === '/api/entities/SystemSettings') return json([
      { setting_key: 'team_card_display', setting_value: JSON.stringify({ show_last_activity: false }) },
    ]);
    return json([]);
  });
  await page.goto(`/tests/fixtures/team-directory/index.html${restricted ? '?restricted' : ''}`);
  return state;
}

async function select(page, label, value) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name: value, exact: true }).click();
}

test('card/list metadata, all six header directions, shared sorts and keyboard views', async ({ page }) => {
  const state = await fixture(page);
  await expect(page.getByRole('button', { name: 'Cards', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('Never logged in', { exact: true })).toBeVisible();
  await expect(page.getByText('Unknown', { exact: true })).toBeVisible();
  await expect(page.getByText('Date joined: 2 Jan 2020', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('4 Jan 2026', { exact: true }).first()).toBeVisible();
  const list = page.getByRole('button', { name: 'List', exact: true });
  await list.focus(); await page.keyboard.press('Enter');
  await expect(list).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('columnheader')).toHaveCount(7);
  for (const name of ['First name', 'Last name', 'Email', 'Date joined', 'Role', 'Last activity']) {
    const header = page.getByRole('columnheader', { name, exact: true });
    await header.getByRole('button').click();
    const first = await header.getAttribute('aria-sort');
    expect(['ascending', 'descending']).toContain(first);
    await header.getByRole('button').click();
    await expect(header).toHaveAttribute('aria-sort', first === 'ascending' ? 'descending' : 'ascending');
  }
  await select(page, 'Sort by', 'First name');
  await page.getByRole('button', { name: /Sort direction: descending/ }).click();
  const firstRow = page.locator('tbody tr').first();
  await expect(firstRow).toContainText('Never logged in');
  await expect(firstRow).toHaveClass(/bg-amber/);
  await page.screenshot({ path: '/tmp/team-directory-list.png' });
  await page.getByRole('button', { name: 'Cards', exact: true }).click();
  await select(page, 'Sort by', 'Date joined');
  await expect(page.getByRole('button', { name: /Sort direction/ })).toContainText('Oldest first');
  await select(page, 'Sort by', 'Last activity');
  await expect(page.getByRole('button', { name: /Sort direction/ })).toContainText('Oldest first');
  await page.screenshot({ path: '/tmp/team-directory-cards.png' });
  expect(state.writes).toEqual([]);
});

test('complete multi-batch team, size transitions, filtering and update clamp', async ({ page }) => {
  const state = await fixture(page, { count: 1105, restricted: true });
  await expect(page.getByRole('status')).toHaveText('Showing 1–9 of 1104 members');
  expect(state.calls.map(c => c.offset)).toEqual([0, 500, 1000]);
  expect(state.calls.every(c => c.sort.id === 'asc' && c.filter.organization_id === 'org')).toBe(true);
  await page.getByRole('button', { name: 'List', exact: true }).click();
  for (const size of ['25', '50', '100', 'Show all members', '9']) {
    await select(page, 'Members per page', size);
    await expect(page.locator('tbody tr')).toHaveCount(size === 'Show all members' ? 1104 : Number(size));
  }
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Showing 10–18 of 1104 members');
  await page.getByTestId('input-team-search').fill('Person1104');
  await expect(page.getByRole('status')).toHaveText('Showing 1–1 of 1 member');
  await expect(page.locator('tbody tr')).toContainText('Person1104');
  await page.getByRole('button', { name: 'Cards', exact: true }).click();
  await expect(page.getByTestId('input-team-search')).toHaveValue('Person1104');
  await page.getByTestId('input-team-search').fill('not-a-member');
  await expect(page.getByText('No members found')).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('Showing 0–0 of 0 members');
  await page.getByTestId('input-team-search').fill('');
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  state.members = state.members.slice(0, 2);
  await page.evaluate(() => window.refreshTeam());
  await expect(page.getByRole('status')).toHaveText('Showing 1–2 of 2 members');
  expect(state.writes).toEqual([]);
});

test('authorised actions and effective-date flow retained, restricted actions absent', async ({ page }) => {
  const state = await fixture(page, { count: 4 });
  await page.getByRole('button', { name: 'List', exact: true }).click();
  await page.getByRole('button', { name: 'Edit Person0000 Surname0004' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByTestId('select-team-role-m0000').click();
  await page.getByRole('option', { name: 'Zulu', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Effective From date required');
  expect(state.writes).toEqual([]);
  await page.keyboard.press('Escape');
  await page.getByRole('switch', { name: 'Show inactive accounts' }).click();
  await expect(page.getByRole('status')).toHaveText('Showing 1–4 of 4 members');
  await page.getByTestId('select-role-filter').click();
  await page.getByRole('option', { name: 'Zulu', exact: true }).click();
  await expect(page.locator('tbody tr')).toHaveCount(2);
  await page.getByRole('button', { name: 'Cards', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Showing 1–2 of 2 members');
  await page.goto('/tests/fixtures/team-directory/index.html?restricted');
  await expect(page.getByRole('button', { name: /^Edit / })).toHaveCount(0);
  await expect(page.locator('[data-testid^="select-team-role"]')).toHaveCount(0);
  await page.getByRole('button', { name: 'List', exact: true }).click();
  await expect(page.getByRole('button', { name: /^Edit / })).toHaveCount(0);
  await expect(page.getByRole('switch')).toHaveCount(0);
  expect(state.writes).toEqual([]);
});

test('batch error never exposes partial data and retry recovers', async ({ page }) => {
  const state = await fixture(page, { count: 501, fail: true });
  await expect(page.getByRole('alert')).toContainText('Unable to load the complete team');
  await expect(page.getByText('Person0000', { exact: true })).toHaveCount(0);
  state.fail = false;
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Showing 1–9 of 500 members');
});

test('narrow layouts remain within viewport and controls work by keyboard', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await fixture(page, { restricted: true });
  await expect(page.getByText('Never logged in', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'List', exact: true }).focus();
  await page.keyboard.press('Space');
  await expect(page.getByRole('table')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('combobox', { name: 'Members per page' }).focus();
  await page.keyboard.press('Enter'); await page.keyboard.press('End'); await page.keyboard.press('Enter');
  await expect(page.locator('tbody tr')).toHaveCount(30);
  await page.screenshot({ path: '/tmp/team-directory-mobile.png' });
});
