import { test, expect } from '@playwright/test';

const ADMIN = { id: 'fields-admin', tenant_id: 'fields-tenant', role_id: 'fields-role', email: 'admin@example.invalid', member_excluded_features: [] };
const ROLE = { id: ADMIN.role_id, tenant_id: ADMIN.tenant_id, name: 'Administrator', excluded_features: [] };
ADMIN.sessionRole = { status: 'ready', member_id: ADMIN.id, tenant_id: ADMIN.tenant_id, role_id: ADMIN.role_id, role: ROLE };
const types = ['text','textarea','number','date','select','boolean','email','url'];
const fields = types.map((type, i) => ({ id: `00000000-0000-0000-0000-${String(i).padStart(12,'0')}`, name: `Fixture ${type}`, type, choices: type === 'select' ? ['Alpha','Beta'] : [], show_on_detail: true }));
const values = ['A short value', 'Line one\nLine two', 0, '2026-10-07', 'Alpha', false, 'a@example.test', 'https://example.test/' + 'long'.repeat(40)];
const group = {
  id: 'fixture-group', tenant_id: ADMIN.tenant_id, name: 'Fixture group',
  is_active: true, allow_self_join: true, roles: ['Member'], default_self_join_role: 'Member', leadership_roles: [], description: '', about_the_group: '<p>About fixture text</p>',
  custom_field_values: Object.fromEntries(fields.map((f,i) => [f.id,values[i]])),
  custom_fields_display: fields.map((f,i) => ({ ...f, value: values[i] })),
};
async function fixture(page, about = true, available = true) {
  const state = { group: { ...group, about_the_group: about ? group.about_the_group : '' }, writes: [], errors: [] };
  page.on('pageerror', e => state.errors.push(e.message));
  await page.context().route(/\/(rest|auth)\/v1\//, route => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.context().route('**/api/**', route => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (!path.startsWith('/api/')) return route.continue();
    const json = data => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
    if (!['GET','HEAD','OPTIONS'].includes(req.method())) {
      if (path === '/api/entities/MemberGroup/fixture-group' && req.method() === 'PATCH') {
        const data = req.postDataJSON();
        state.writes.push(data);
        state.group = { ...state.group, ...data };
        return json(state.group);
      }
      return route.fulfill({ status: 599, body: 'Unexpected fixture mutation blocked' });
    }
    if (path === '/api/auth/me') return json(ADMIN);
    if (path === '/api/auth/tenant-user-me') return json({ user: ADMIN, tenant: { id: ADMIN.tenant_id, slug: 'fixture' } });
    if (path === `/api/entities/Member/${ADMIN.id}`) return json(ADMIN);
    if (path === `/api/entities/Role/${ROLE.id}`) return json(ROLE);
    if (path === '/api/entities/Role') return json([ROLE]);
    if (path === '/api/member-groups/custom-fields') return json(available ? { fields, revision: 1 } : { fields: [], revision: 0, available: false });
    if (path === '/api/entities/MemberGroup') return json([state.group]);
    if (path === '/api/entities/MemberGroup/fixture-group') return json(state.group);
    if (path === '/api/public/tenant-branding') return json({ success: true, branding: { name: 'Fixture', primaryColor: '#155e75' } });
    if (path === '/api/public/microsites') return json({ microsites: [] });
    return json([]);
  });
  return state;
}
for (const width of [390, 1280]) {
  test(`detail fields follow About and preserve typography/line breaks at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const state = await fixture(page);
    await page.goto('/MemberGroupDetail?id=fixture-group');
    const about = page.getByTestId('text-group-about');
    const first = page.getByTestId(`text-group-custom-field-${fields[0].id}`);
    await expect(first).toHaveText(values[0]);
    await expect(page.getByTestId(`text-group-custom-field-${fields[2].id}`)).toHaveText('0');
    await expect(page.getByTestId(`text-group-custom-field-${fields[5].id}`)).toHaveText('No');
    expect((await first.boundingBox()).y).toBeGreaterThan((await about.boundingBox()).y);
    const metrics = await first.evaluate(el => ({ size: getComputedStyle(el).fontSize, width: el.getBoundingClientRect().width }));
    expect(metrics.size).toBe(await about.evaluate(el => getComputedStyle(el).fontSize));
    expect(metrics.width).toBeLessThanOrEqual(width);
    expect(await page.getByTestId(`text-group-custom-field-${fields[1].id}`).evaluate(el => getComputedStyle(el).whiteSpace)).toBe('pre-wrap');
    expect(state.errors).toEqual([]);
  });
}
test('published fields remain when About is empty', async ({ page }) => {
  await fixture(page, false);
  await page.goto('/MemberGroupDetail?id=fixture-group');
  await expect(page.getByTestId(`text-group-custom-field-${fields[0].id}`)).toBeVisible();
  await expect(page.getByTestId('text-group-about')).toHaveCount(0);
});

test('management modal reloads all types, saves clearing/zero/No, and deliberately duplicates values', async ({ page }) => {
  const state = await fixture(page);
  await page.goto('/MemberGroupManagement');
  const edit = page.getByTitle('Duplicate', { exact: true }).locator('..').getByRole('button').filter({ has: page.locator('svg.lucide-pencil') });
  await edit.click();
  const modal = page.getByRole('dialog', { name: /^(Edit Group|Create New Group)$/ });
  await expect(modal.getByLabel('Fixture text', { exact: true })).toHaveValue(values[0]);
  await expect(modal.getByLabel('Fixture textarea', { exact: true })).toHaveValue(values[1]);
  await expect(modal.getByLabel('Fixture number', { exact: true })).toHaveValue('0');
  await expect(modal.getByLabel('Fixture boolean', { exact: true })).toHaveText('No');
  await modal.getByLabel('Fixture text', { exact: true }).fill('');
  await modal.getByLabel('Fixture textarea', { exact: true }).fill('Edited\nLines');
  await modal.getByRole('button', { name: 'Update Group', exact: true }).click();
  await expect(modal).toHaveCount(0);
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0].custom_field_values[fields[0].id]).toBeUndefined();
  expect(state.writes[0].custom_field_values[fields[2].id]).toBe(0);
  expect(state.writes[0].custom_field_values[fields[5].id]).toBe(false);
  await edit.click();
  await expect(modal.getByLabel('Fixture textarea', { exact: true })).toHaveValue('Edited\nLines');
  await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByTitle('Duplicate', { exact: true }).click();
  await expect(modal.getByLabel('Fixture textarea', { exact: true })).toHaveValue('Edited\nLines');
  await expect(modal.getByLabel('Fixture boolean', { exact: true })).toHaveText('No');
  expect(state.errors).toEqual([]);
});

test('before migration, settings are gated and legacy group edits omit the new column', async ({ page }) => {
  const state = await fixture(page, true, false);
  await page.goto('/MemberGroupSettings');
  await expect(page.getByText('Custom fields are awaiting a database upgrade. Existing groups can still be created and edited.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add field', exact: true })).toHaveCount(0);
  await page.goto('/MemberGroupManagement');
  await page.getByTitle('Duplicate', { exact: true }).locator('..').getByRole('button').filter({ has: page.locator('svg.lucide-pencil') }).click();
  const modal = page.getByRole('dialog', { name: 'Edit Group', exact: true });
  await expect(modal.getByText('Custom fields are awaiting a database upgrade. Other group details can still be saved.')).toBeVisible();
  await modal.getByRole('button', { name: 'Update Group', exact: true }).click();
  await expect(modal).toHaveCount(0);
  expect(state.writes).toHaveLength(1);
  expect(Object.hasOwn(state.writes[0], 'custom_field_values')).toBe(false);
  expect(state.errors).toEqual([]);
});
