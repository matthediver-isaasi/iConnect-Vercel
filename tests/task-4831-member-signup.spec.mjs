import { test, expect } from '@playwright/test';

const slug = 'fixture-member-signup';
const draftToken = 'fixture-opaque-draft-token';
const fixtureForm = {
  id: 'fixture-member-signup-id',
  slug,
  name: 'Member signup fixture',
  blank_layout: true,
  form_type: 'application',
  is_active: true,
  require_authentication: false,
  allow_save_continue_later: true,
  submit_button_text: 'Submit fixture',
  mutation_access_policy: { version: 1, mode: 'public_member_signup' },
  fields: [
    { id: 'fixture-first-name', type: 'text', label: 'First name', required: true },
    { id: 'fixture-email', type: 'email', label: 'Email', required: true },
  ],
  pages: [],
  entity_pipelines: {
    members: [{
      id: 'signup',
      uniqueness_key: 'email',
      mappings: [{ source_field_id: 'fixture-email', target_type: 'core', target_field: 'email' }],
    }],
    organisations: [],
  },
};

async function installFixture(page, { collision = false, draft = false, owner = false } = {}) {
  const writes = [];
  const submissions = [];
  const requests = [];
  const errors = [];
  const formQueries = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('requestfailed', request => errors.push(`${request.url()}: ${request.failure()?.errorText}`));
  const respond = (route, body, status = 200) => route.fulfill({
    status, contentType: 'application/json', body: JSON.stringify(body),
  });
  await page.context().route(/\/(?:rest|auth)\/v1\/|\/functions\/v1\//, route =>
    respond(route, { error: 'External API blocked by isolated fixture' }, 599));
  await page.context().route('**/api/**', route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (!path.startsWith('/api/')) return route.continue();
    requests.push(`${method} ${path}`);
    if (/\/(?:subdomain|tenant)\/lookup(?:\/|$)/i.test(path)) return respond(route, { tenant: null });
    if (method === 'GET' && path === `/api/public/form/${slug}`) {
      formQueries.push(new URL(request.url()).searchParams.get('authenticated'));
      return respond(route, fixtureForm);
    }
    if (method === 'GET' && path === '/api/public/form-draft' && draft) {
      return respond(route, {
        success: true,
        draft: { draft_data: { 'fixture-first-name': 'Drafted person', 'fixture-email': 'draft@example.test' } },
      });
    }
    if (method === 'POST' && path === '/api/public/form-submission') {
      submissions.push(request.postDataJSON());
      return collision
        ? respond(route, { error: 'Existing member requires verified ownership', code: 'FORM_MEMBER_OWNER_REQUIRED' }, 403)
        : respond(route, { id: 'fixture-created-submission' });
    }
    if (method === 'POST' && path === '/api/forms/send-submission-email') {
      writes.push({ method, path, mocked: true });
      return respond(route, { success: true });
    }
    if (owner && method === 'PATCH' && path === `/api/entities/Form/${fixtureForm.id}`) {
      writes.push({ method, path, mocked: true });
      return respond(route, { ...fixtureForm, submission_count: 1 });
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      writes.push({ method, path, unexpected: true });
      return respond(route, { error: 'Unexpected write blocked by isolated fixture' }, 599);
    }
    if (path === '/api/auth/me' || path === '/api/auth/tenant-user-me') {
      return owner ? respond(route, {
        id: 'fixture-owner-member', tenant_id: 'fixture-tenant',
        role_id: 'fixture-owner-role',
        email: 'existing@example.test', first_name: 'Existing', last_name: 'Person',
        member_excluded_features: [],
      }) : respond(route, null, 401);
    }
    if (path === '/api/entities/Role/fixture-owner-role') {
      return respond(route, { id: 'fixture-owner-role', name: 'Member', excluded_features: [] });
    }
    if (path === '/api/entities/Role') {
      return respond(route, [{ id: 'fixture-owner-role', name: 'Member', excluded_features: [] }]);
    }
    if (path === '/api/auth/tenant-public-settings') {
      return respond(route, { success: true, settings: { member_google_login_enabled: false } });
    }
    return respond(route, []);
  });
  return { writes, submissions, requests, errors, formQueries };
}

test('anonymous new-member signup shows guidance and reaches mocked success', async ({ page }) => {
  const state = await installFixture(page);
  await page.goto(`/FormView?slug=${slug}`);
  await expect(page.getByTestId('public-member-signup-notice')).toBeVisible();
  await page.getByRole('textbox').nth(0).fill('New person');
  await page.getByRole('textbox').nth(1).fill('new@example.test');
  await page.getByTestId('button-submit-form').click();
  await expect(page.getByRole('heading', { name: 'Success!' })).toBeVisible();
  expect(state.submissions).toHaveLength(1);
  expect(state.requests, JSON.stringify(state.errors)).toContain('POST /api/public/form-submission');
  expect(state.submissions[0].submission_data['fixture-email']).toBe('new@example.test');
  expect(state.writes.filter(write => write.unexpected)).toEqual([]);
  await page.screenshot({ path: '/tmp/task-4831-new-member.png', fullPage: true });
});

test('anonymous existing-member collision displays verified-owner sign-in guidance', async ({ page }) => {
  const state = await installFixture(page, { collision: true });
  await page.goto(`/FormView?slug=${slug}`);
  await page.getByRole('textbox').nth(0).fill('Existing person');
  await page.getByRole('textbox').nth(1).fill('existing@example.test');
  await page.getByTestId('button-submit-form').click();
  await expect(page.getByTestId('submission-error')).toContainText('Sign in as its owner');
  await expect(page.getByTestId('public-member-signin')).toBeVisible();
  expect(state.submissions).toHaveLength(1);
  expect(state.requests, JSON.stringify(state.errors)).toContain('POST /api/public/form-submission');
  expect(state.writes).toEqual([]);
  await page.screenshot({ path: '/tmp/task-4831-existing-member-collision.png', fullPage: true });
});

test('login uses validated returnTo preserving draft; draft does not establish ownership', async ({ page }) => {
  const state = await installFixture(page, { collision: true, draft: true });
  await page.goto(`/FormView?slug=${slug}&draft=${draftToken}`);
  await expect(page.getByRole('textbox').nth(0)).toHaveValue('Drafted person');
  expect(state.requests, JSON.stringify(state.errors)).toContain('GET /api/public/form-draft');
  const link = page.getByTestId('public-member-signin');
  const href = await link.getAttribute('href');
  expect(new URL(href, 'https://fixture.invalid').searchParams.get('returnTo'))
    .toBe(`/FormView?slug=${slug}&draft=${draftToken}`);
  await link.click();
  await expect(page).toHaveURL(new RegExp('/login\\?returnTo='));
  expect(new URL(page.url()).searchParams.get('returnTo'))
    .toBe(`/FormView?slug=${slug}&draft=${draftToken}`);
  expect(state.submissions).toHaveLength(0);
  expect(state.writes).toEqual([]);
  await page.screenshot({ path: '/tmp/task-4831-login-draft-return.png', fullPage: true });
});

test('verified-owner session requests authenticated form and sees no anonymous signup prompt', async ({ page }) => {
  const state = await installFixture(page, { owner: true });
  await page.goto(`/FormView?slug=${slug}`);
  await expect(page.getByRole('textbox').nth(0)).toBeVisible();
  await expect(page.getByTestId('public-member-signup-notice')).toHaveCount(0);
  expect(state.formQueries).toContain('1');
  expect(state.requests, JSON.stringify(state.errors)).toContain('GET /api/auth/me');
  await page.screenshot({ path: '/tmp/task-4831-owner-form.png', fullPage: true });
  await page.getByRole('textbox').nth(0).fill('Existing person');
  await page.getByRole('textbox').nth(1).fill('existing@example.test');
  await page.getByTestId('button-submit-form').click();
  await expect(page.getByRole('heading', { name: 'Success!' })).toBeVisible();
  expect(state.submissions).toHaveLength(1);
  expect(state.submissions[0].submitted_by_email).toBe('existing@example.test');
  expect(state.writes.filter(write => write.unexpected)).toEqual([]);
  await page.screenshot({ path: '/tmp/task-4831-verified-owner.png', fullPage: true });
});