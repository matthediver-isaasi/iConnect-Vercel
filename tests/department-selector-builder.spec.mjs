import { test, expect } from '@playwright/test';
import metadataHandler from '../api/forms/[formId]/editor-metadata.js';
import { DEPARTMENT_CURRENT_SET_FORM_ID as formId, DEPARTMENT_CURRENT_SET_TENANT_ID as tenantId } from '../api/_lib/departmentCurrentSet.js';

// Real SPA and real metadata handler with in-memory server configuration.
// This is NOT a signed-in deployed tenant check. No live APIs or writes.
const member = {
  id: '11111111-1111-4111-8111-111111111111', tenant_id: tenantId,
  role_id: '22222222-2222-4222-8222-222222222222',
  email: 'builder@example.invalid', first_name: 'Builder', last_name: 'Fixture',
};
const role = { id: member.role_id, name: 'Administrator', excluded_features: [] };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function setup(page, { layout = 'standard', pages = [], fields = [], configured = true, failed = false, allowFixtureSave = false } = {}) {
  const form = {
    id: formId, tenant_id: tenantId, name: 'Department builder fixture', slug: 'department-builder-fixture',
    layout_type: layout, fields, pages, is_active: true, form_type: 'standard',
  }; // Deliberately no current_set_enabled in the generic list.
  const state = { writes: [], saves: [], pageErrors: [], metadataReads: 0, failed };
  page.on('pageerror', error => state.pageErrors.push(error.message));
  await page.context().route('**/*', route => {
    const url = new URL(route.request().url());
    if (route.request().isNavigationRequest()) return route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><head><script type="module">
        import RefreshRuntime from '/@react-refresh';
        RefreshRuntime.injectIntoGlobalHook(window);
        window.$RefreshReg$ = () => {};
        window.$RefreshSig$ = () => type => type;
        window.__vite_plugin_react_preamble_installed__ = true;
      </script></head><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>`,
    });
    if (url.origin !== new URL(test.info().project.use.baseURL).origin) return route.abort();
    return route.continue();
  });
  await page.context().route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (!path.startsWith('/api/')) return route.continue();
    if (allowFixtureSave && path === `/api/entities/Form/${formId}` && request.method() === 'PATCH') {
      const patch = request.postDataJSON();
      expect(patch).not.toHaveProperty('current_set_enabled');
      expect(patch).not.toHaveProperty('current_set_configuration');
      expect(patch.fields.every(field => field.type !== 'department_selector_layout')).toBe(true);
      state.saves.push(patch);
      Object.assign(form, patch);
      return json(route, form);
    }
    if (request.method() !== 'GET') {
      state.writes.push(`${request.method()} ${path}`);
      return json(route, { error: 'Mutation forbidden in fixture' }, 599);
    }
    if (path === '/api/auth/me' || path === `/api/entities/Member/${member.id}`) return json(route, member);
    if (path === '/api/auth/tenant-user-me') return json(route, { user: member, tenant: { id: tenantId } });
    if (path === `/api/entities/Role/${role.id}`) return json(route, role);
    if (path === '/api/entities/Role') return json(route, [role]);
    if (path === '/api/entities/Form') return json(route, [form]);
    if (path === `/api/forms/${formId}/editor-metadata`) {
      state.metadataReads++;
      expect(request.headers()['x-tenant-id']).toBe(tenantId);
      const db = {
        from(table) {
          const filters = [];
          return {
            select() { return this; },
            eq(key, value) { filters.push([key, value]); return this; },
            async maybeSingle() {
              const row = table === 'form' ? form : configured ? {
                tenant_id: tenantId, form_id: formId,
                config: { workforce_container_field_id: 'workforce', equipment_container_field_id: 'equipment', private_mapping: 'must-not-leak' },
              } : null;
              return { data: row && filters.every(([key, value]) => row[key] === value) ? row : null,
                error: state.failed && table !== 'form' ? { code: '42P01' } : null };
            },
          };
        },
      };
      const response = {
        code: 200, body: null, setHeader() {}, status(code) { this.code = code; return this; },
        json(body) { this.body = body; return this; },
      };
      await metadataHandler({ method: 'GET', query: { formId } }, response, {
        db, getTenantContext: async () => ({ isAuthenticated: true, tenantId }), hasAdminAccess: async () => true,
      });
      expect(JSON.stringify(response.body)).not.toContain('must-not-leak');
      return json(route, response.body, response.code);
    }
    if (path === '/api/public/tenant-branding') return json(route, { success: true, branding: { name: 'Fixture' } });
    if (path === '/api/public/microsites') return json(route, { microsites: [] });
    if (path === '/api/admin/integrations') return json(route, { integrations: [] });
    return json(route, []);
  });
  return state;
}

for (const scenario of [
  { name: 'empty standard', fields: [] },
  { name: 'empty paginated', pages: [{ id: 'first', title: 'First' }, { id: 'second', title: 'Second' }] },
  { name: 'card swipe', layout: 'card_swipe' },
  { name: 'paginated saved anchor', pages: [{ id: 'first', title: 'First' }, { id: 'second', title: 'Second' }],
    fields: [{ id: 'intro', label: 'Introduction', type: 'text', page_id: 'first' },
      { id: 'name', label: 'Name', type: 'text', page_id: 'first', department_selector_before: true },
      { id: 'later', label: 'Later', type: 'text', page_id: 'second' }] },
]) {
  test(`${scenario.name} gets exactly one automatic non-deletable selector from verified metadata`, async ({ page }) => {
    const state = await setup(page, scenario);
    await page.goto(`/FormBuilder?formId=${formId}`, { waitUntil: 'domcontentloaded' });
    const block = page.getByTestId('department-selector-builder-block');
    await expect(block).toBeVisible({ timeout: 60_000 });
    await expect(block).toHaveCount(1);
    await expect(block.getByRole('button')).toHaveCount(0);
    if (scenario.layout === 'card_swipe') await expect(block).toContainText('Required at the beginning');
    if (scenario.fields?.length) {
      const cards = page.locator('[data-rfd-draggable-id]');
      await expect(cards.nth(0)).toHaveAttribute('data-rfd-draggable-id', 'intro');
      await expect(cards.nth(1)).toHaveAttribute('data-rfd-draggable-id', '__department_selector_layout__');
    }
    expect(state.metadataReads).toBeGreaterThan(0);
    expect(state.pageErrors).toEqual([]);
    expect(state.writes).toEqual([]);
  });
}

test('ordinary Department relationship dropdown never enables the selector', async ({ page }) => {
  const state = await setup(page, { configured: false, fields: [{ id: 'dept', type: 'relationship_dropdown', label: 'Department' }] });
  await page.goto(`/FormBuilder?formId=${formId}`);
  await expect(page.getByRole('heading', { name: 'Department builder fixture', exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('department-selector-builder-block')).toHaveCount(0);
  expect(state.writes).toEqual([]);
});

test('unavailable metadata blocks editing, and Retry restores the automatic selector', async ({ page }) => {
  const state = await setup(page, { failed: true });
  await page.goto(`/FormBuilder?formId=${formId}`);
  await expect(page.getByTestId('form-editor-metadata-error')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('department-selector-builder-block')).toHaveCount(0);
  state.failed = false;
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByTestId('department-selector-builder-block')).toHaveCount(1);
  expect(state.writes).toEqual([]);
});

test('moving the virtual selector saves only its field anchor and reopens at the saved position', async ({ page }) => {
  const state = await setup(page, { allowFixtureSave: true, fields: [
    { id: 'intro', type: 'text', label: 'Introduction' },
    { id: 'details', type: 'text', label: 'Details' },
  ] });
  await page.goto(`/FormBuilder?formId=${formId}`);
  const block = page.getByTestId('department-selector-builder-block');
  await expect(block).toBeVisible({ timeout: 60_000 });
  await block.focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Space');
  const cards = page.locator('[data-rfd-draggable-id]');
  await expect(cards.nth(0)).toHaveAttribute('data-rfd-draggable-id', 'intro');
  await expect(cards.nth(1)).toHaveAttribute('data-rfd-draggable-id', '__department_selector_layout__');
  await page.getByRole('button', { name: 'Save Form', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Protected form', exact: true });
  // Synthetic password goes only to the intercepted in-memory PATCH above.
  // This is not a check or bypass of the real protection-password boundary.
  await dialog.getByTestId('input-form-protection-password').fill('fixture-only');
  await dialog.getByRole('button', { name: 'Save Form', exact: true }).click();
  await expect.poll(() => state.saves.length).toBe(1);
  expect(state.saves[0].fields.find(field => field.id === 'details').department_selector_before).toBe(true);
  await page.reload();
  await expect(page.getByTestId('department-selector-builder-block')).toHaveCount(1);
  await expect(cards.nth(1)).toHaveAttribute('data-rfd-draggable-id', '__department_selector_layout__');
  expect(state.pageErrors).toEqual([]);
  expect(state.writes).toEqual([]);
});
