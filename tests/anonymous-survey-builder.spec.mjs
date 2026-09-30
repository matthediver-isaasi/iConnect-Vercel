import { test, expect } from '@playwright/test';

const ADMIN = {
  id: 'survey-builder-admin', tenant_id: 'survey-builder-tenant',
  organization_id: 'survey-builder-org', role_id: 'survey-builder-role',
  email: 'builder@example.invalid', first_name: 'Survey', last_name: 'Administrator',
  member_excluded_features: [],
};
const ROLE = { id: ADMIN.role_id, name: 'Administrator', excluded_features: [] };

async function install(page, { formType = 'survey', identity = 'identified', enhanced = false, responses = false } = {}) {
  const state = {
    saves: [], unexpectedWrites: [], errors: [],
    form: {
      id: 'survey-builder-fixture', slug: 'survey-builder-fixture',
      name: 'Anonymous setup fixture', form_type: formType,
      layout_type: 'standard', is_active: true, require_authentication: false,
      fields: [{ id: 'quality', type: 'text', label: 'Quality', required: false }],
      pages: [], visibility_rules: [], prefill_source: 'none',
      entity_pipelines: { members: [], organisations: [] },
      structured_actions: { version: 1, actions: [] },
      allow_save_continue_later: !enhanced,
      survey_settings: {
        status: 'draft', response_identity: identity,
        ...(enhanced ? { anonymous_completion_version: 1 } : {}),
      },
    },
  };
  page.on('pageerror', error => state.errors.push(error.message));
  await page.context().routeWebSocket('**/*', socket => socket.onMessage(() => {}));
  await page.context().route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (body, status = 200) => route.fulfill({ status,
      contentType: 'application/json', body: JSON.stringify(body) });
    if (url.origin !== 'http://127.0.0.1:5000') return route.fulfill({ status: 204, body: '' });
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const path = url.pathname;
    if (path === `/api/entities/Form/${state.form.id}` && request.method() === 'PATCH') {
      const patch = request.postDataJSON();
      state.saves.push(patch);
      state.form = { ...state.form, ...patch };
      return json(state.form);
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
      state.unexpectedWrites.push(path);
      return json({ error: 'Unexpected browser fixture write' }, 599);
    }
    if (path === '/api/auth/me') return json(ADMIN);
    if (path === '/api/auth/tenant-user-me') return json({
      user: ADMIN, tenant: { id: ADMIN.tenant_id, slug: 'survey-builder' },
    });
    if (path === `/api/entities/Member/${ADMIN.id}`) return json(ADMIN);
    if (path === `/api/entities/Role/${ROLE.id}`) return json(ROLE);
    if (path === '/api/entities/Role') return json([ROLE]);
    if (path === '/api/entities/Form') return json([state.form]);
    if (path === `/api/entities/Form/${state.form.id}`) return json(state.form);
    if (path === '/api/entities/FormSubmission') return json(responses ? [{ id: 'response', form_id: state.form.id }] : []);
    if (path === '/api/public/tenant-branding') return json({
      success: true, branding: { name: 'Survey fixture', primaryColor: '#155e75', footerConfig: {} },
    });
    return json([]);
  });
  await page.goto(`/FormBuilder?formId=${state.form.id}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('button', { name: 'Save Form' })).toBeVisible();
  return state;
}

test('Standard forms have no survey privacy or completion controls', async ({ page }) => {
  const state = await install(page, { formType: 'standard' });
  await expect(page.getByTestId('tab-survey')).toHaveCount(0);
  await expect(page.getByTestId('select-survey-identity')).toHaveCount(0);
  await expect(page.getByTestId('anonymous-completion-explanation')).toHaveCount(0);
  expect(state.unexpectedWrites).toEqual([]);
  expect(state.errors).toEqual([]);
});

test('existing legacy anonymous policy stays legacy when saved', async ({ page }) => {
  const state = await install(page, { identity: 'anonymous' });
  await page.getByTestId('tab-survey').click();
  await expect(page.getByTestId('select-survey-identity')).toContainText('legacy policy');
  await expect(page.getByTestId('anonymous-completion-explanation')).toHaveCount(0);
  await page.getByRole('button', { name: 'Save Form' }).click();
  await expect.poll(() => state.saves.length).toBe(1);
  expect(state.saves[0].survey_settings.response_identity).toBe('anonymous');
  expect(state.saves[0].survey_settings.anonymous_completion_version).toBeUndefined();
  expect(state.unexpectedWrites).toEqual([]);
  expect(state.errors).toEqual([]);
});

test('enhanced selection explains named completion and blocks incompatible drafts actionably', async ({ page }) => {
  const state = await install(page);
  await page.getByTestId('tab-survey').click();
  await page.getByTestId('select-survey-identity').click();
  await page.getByRole('option', { name: 'Anonymous answers with separate completion', exact: true }).click();
  await expect(page.getByTestId('anonymous-completion-explanation')).toContainText('cannot link a member to their answers');
  await expect(page.getByTestId('anonymous-completion-explanation')).toContainText('verified recipient invitation');
  await expect(page.getByTestId('survey-validation-issues')).toContainText('Turn off Save & Continue Later');
  await expect(page.getByTestId('button-publish-survey')).toBeDisabled();
  await page.getByRole('button', { name: 'Save Form' }).click();
  await expect(page.getByText(/Failed to update form: Turn off Save & Continue Later/)).toBeVisible();
  expect(state.saves).toEqual([]);
  expect(state.unexpectedWrites).toEqual([]);
  expect(state.errors).toEqual([]);
  await page.screenshot({ path: '/tmp/anonymous-survey-builder-validation.jpg', fullPage: true });
});

test('response policy and repeat-submission control lock after responses', async ({ page }) => {
  const state = await install(page, { identity: 'anonymous', enhanced: true, responses: true });
  await page.getByTestId('tab-survey').click();
  await expect(page.getByTestId('select-survey-identity')).toBeDisabled();
  await expect(page.getByTestId('switch-survey-one-submission')).toBeDisabled();
  await expect(page.getByTestId('anonymous-completion-explanation')).toBeVisible();
  expect(state.unexpectedWrites).toEqual([]);
  expect(state.errors).toEqual([]);
});