import { test, expect } from '@playwright/test';

const PROTECTED_FORM_ID = '8b6f44d3-83f8-449e-9496-b10b1dc28e5f';
const PROTECTED_TENANT_ID = 'ff2df806-b321-4254-b651-3af11fccf1db';
const OTHER_FORM_ID = '11111111-1111-4111-8111-111111111111';
const TEST_SECRET = 'browser-fixture-secret-only';
const HELPER_MESSAGE = 'This form is protected and cannot be deleted, contact isaasi for details.';

const member = {
  id: '22222222-2222-4222-8222-222222222222',
  tenant_id: PROTECTED_TENANT_ID,
  organization_id: '33333333-3333-4333-8333-333333333333',
  role_id: '44444444-4444-4444-8444-444444444444',
  email: 'protected-form-admin@example.invalid',
  first_name: 'Protected',
  last_name: 'Form Admin',
  member_excluded_features: [],
};

const role = {
  id: member.role_id,
  name: 'Administrator',
  excluded_features: [],
};

function formFixture(id, name) {
  return {
    id,
    tenant_id: PROTECTED_TENANT_ID,
    name,
    slug: id === PROTECTED_FORM_ID ? 'protected-department-form' : 'ordinary-form',
    description: 'Original browser fixture description',
    layout_type: 'standard',
    form_width: 'narrow',
    fields: [{
      id: `${id}-name`,
      type: 'text',
      label: 'Name',
      required: false,
      options: [],
    }],
    pages: [],
    visibility_rules: [],
    entity_pipelines: { members: [], organisations: [] },
    structured_actions: { version: 1, actions: [] },
    field_mappings: [],
    submission_emails: [],
    require_authentication: true,
    access_policy: null,
    is_active: true,
    is_contract: false,
    form_type: 'standard',
    survey_settings: {},
    owners: [],
    submission_count: 0,
  };
}

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

async function installFixtures(page) {
  const state = {
    forms: [
      formFixture(PROTECTED_FORM_ID, 'Protected Department Form'),
      formFixture(OTHER_FORM_ID, 'Ordinary Form'),
    ],
    patches: [],
    deletes: [],
    verifications: [],
    unexpectedWrites: [],
    pageErrors: [],
  };
  page.on('pageerror', error => state.pageErrors.push(error.message));

  await page.context().route('**/rest/v1/**', route => {
    const method = route.request().method();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      state.unexpectedWrites.push(`${method} ${route.request().url()}`);
      return json(route, { error: 'Direct database writes are disabled in this fixture.' }, 599);
    }
    return json(route, []);
  });
  await page.context().route('**/auth/v1/**', route => json(route, []));

  await page.context().route('**/api/**', async route => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    const method = request.method();
    if (!pathname.startsWith('/api/')) return route.continue();

    if (pathname === '/api/auth/me') return json(route, member);
    if (pathname === '/api/auth/tenant-user-me') {
      return json(route, {
        user: member,
        tenant: { id: PROTECTED_TENANT_ID, slug: 'protected-fixture' },
      });
    }
    if (pathname === `/api/entities/Member/${member.id}`) return json(route, member);
    if (pathname === `/api/entities/Role/${role.id}`) return json(route, role);
    if (pathname === '/api/entities/Role') return json(route, [role]);
    if (pathname === '/api/entities/Form' && method === 'GET') {
      return json(route, state.forms);
    }
    if (pathname === '/api/entities/FormSubmission' && method === 'GET') return json(route, []);
    if (pathname === '/api/bookmarks' && method === 'GET') return json(route, { bookmarks: [] });
    if (pathname === '/api/admin/integrations' && method === 'GET') {
      return json(route, { integrations: [] });
    }
    if (pathname === '/api/public/resource-categories' && method === 'GET') return json(route, []);

    if (pathname === '/api/forms/verify-protection-password' && method === 'POST') {
      const body = request.postDataJSON();
      state.verifications.push(body);
      if (body.form_id !== PROTECTED_FORM_ID || body.password !== TEST_SECRET) {
        return json(route, { error: 'The protection password is incorrect.' }, 403);
      }
      return json(route, { success: true });
    }

    const protectedItemPath = `/api/entities/Form/${PROTECTED_FORM_ID}`;
    if (pathname === protectedItemPath && method === 'PATCH') {
      const headers = request.headers();
      const patch = request.postDataJSON();
      if (headers['x-form-protection-password'] !== TEST_SECRET) {
        return json(route, { error: 'The protection password is incorrect.' }, 403);
      }
      if (patch.is_active === false && headers['x-form-deactivation-confirmed'] !== 'true') {
        return json(route, { error: 'Final confirmation is required.' }, 409);
      }
      state.patches.push({ id: PROTECTED_FORM_ID, patch, headers });
      state.forms[0] = { ...state.forms[0], ...patch };
      return json(route, state.forms[0]);
    }
    if (pathname === protectedItemPath && method === 'DELETE') {
      state.deletes.push(PROTECTED_FORM_ID);
      return json(route, { error: HELPER_MESSAGE }, 403);
    }

    const otherItemPath = `/api/entities/Form/${OTHER_FORM_ID}`;
    if (pathname === otherItemPath && method === 'DELETE') {
      state.deletes.push(OTHER_FORM_ID);
      return json(route, { success: true });
    }

    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      state.unexpectedWrites.push(`${method} ${pathname}`);
      return json(route, { error: `Unexpected fixture mutation: ${method} ${pathname}` }, 599);
    }
    return json(route, []);
  });

  return state;
}

test('builder protected save supports cancel, wrong password, and correct password', async ({ page }) => {
  const state = await installFixtures(page);
  await page.goto(`/FormBuilder?formId=${PROTECTED_FORM_ID}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Protected Department Form' })).toBeVisible();

  await page.getByTestId('tab-settings').click();
  await page.locator('#description').fill('Unsaved protected configuration change');
  await page.getByRole('button', { name: 'Save Form' }).click();
  await expect(page.getByRole('dialog', { name: 'Protected form' })).toBeVisible();
  await page.screenshot({ path: 'screenshots/protected-form.jpg', type: 'jpeg', quality: 85 });

  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('dialog', { name: 'Protected form' })).toBeHidden();
  expect(state.patches).toHaveLength(0);
  await expect(page.locator('#description')).toHaveValue('Unsaved protected configuration change');

  await page.getByRole('button', { name: 'Save Form' }).click();
  await page.getByTestId('input-form-protection-password').fill('wrong-browser-password');
  await page.getByRole('button', { name: 'Save Form' }).last().click();
  await expect(page.getByRole('alert')).toContainText('protection password is incorrect');
  expect(state.patches).toHaveLength(0);
  await expect(page.locator('#description')).toHaveValue('Unsaved protected configuration change');

  await page.getByTestId('input-form-protection-password').fill(TEST_SECRET);
  await page.getByRole('button', { name: 'Save Form' }).last().click();
  await expect(page.getByRole('dialog', { name: 'Protected form' })).toBeHidden();
  expect(state.patches).toHaveLength(1);
  expect(state.patches[0].patch.description).toBe('Unsaved protected configuration change');
  expect(state.patches[0].headers['x-form-protection-password']).toBe(TEST_SECRET);
  expect(state.pageErrors).toEqual([]);
  expect(state.unexpectedWrites).toEqual([]);
});

test('management protected deletion becomes double-confirmed deactivation; ordinary deletion is unchanged', async ({ page }) => {
  const state = await installFixtures(page);
  await page.goto('/FormManagement', { waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Protected Department Form', { exact: true })).toBeVisible();

  await page.getByTestId(`button-delete-${PROTECTED_FORM_ID}`).click();
  await expect(page.getByText(HELPER_MESSAGE, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Deactivate Form' }).click();

  await page.getByTestId('input-form-protection-password').fill('wrong-browser-password');
  await page.getByRole('button', { name: 'Validate password' }).click();
  await expect(page.getByRole('alert')).toContainText('protection password is incorrect');
  expect(state.patches).toHaveLength(0);

  await page.getByTestId('input-form-protection-password').fill(TEST_SECRET);
  await page.getByRole('button', { name: 'Validate password' }).click();
  await expect(page.getByRole('dialog', { name: 'Confirm form deactivation' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  expect(state.patches).toHaveLength(0);

  await page.getByTestId(`button-delete-${PROTECTED_FORM_ID}`).click();
  await page.getByRole('button', { name: 'Deactivate Form' }).click();
  await page.getByTestId('input-form-protection-password').fill(TEST_SECRET);
  await page.getByRole('button', { name: 'Validate password' }).click();
  await page.getByTestId('button-confirm-form-deactivation').click();
  await expect(page.getByRole('dialog', { name: 'Confirm form deactivation' })).toBeHidden();
  expect(state.patches).toHaveLength(1);
  expect(state.patches[0].patch).toEqual({ is_active: false });
  expect(state.patches[0].headers['x-form-deactivation-confirmed']).toBe('true');
  expect(state.deletes).not.toContain(PROTECTED_FORM_ID);

  await page.getByTestId(`button-delete-${OTHER_FORM_ID}`).click();
  await expect(page.getByText(/permanently delete the form "Ordinary Form"/)).toBeVisible();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect.poll(() => state.deletes).toContain(OTHER_FORM_ID);
  expect(state.pageErrors).toEqual([]);
  expect(state.unexpectedWrites).toEqual([]);
});