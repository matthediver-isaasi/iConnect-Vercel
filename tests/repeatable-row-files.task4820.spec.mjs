import { test, expect } from '@playwright/test';

// The saved-form and draft endpoints are in-memory fixtures. No tenant data,
// storage provider, or actual submission endpoint is ever touched.
const FORM_ID = '48200000-0000-4000-8000-000000000001';
const SLUG = 'task-4820-repeatable-file-fixture';
const SOURCE = 'supporting-files';
const PRIVATE = 'private-proof';
const PUBLIC = 'public-photo';
const TOKEN = 'fixture-resume-token';
const json = (route, body, status = 200) => route.fulfill({
  status, contentType: 'application/json', body: JSON.stringify(body),
});

function savedForm(layout) {
  return {
    id: FORM_ID, slug: SLUG, name: 'Repeatable file fixture', title: 'Repeatable file fixture',
    status: 'published', is_active: true, access_level: 'public',
    form_type: 'standard', layout_type: 'standard', fields: [{
      id: SOURCE, type: 'repeatable_rows', label: 'Supporting files', layout,
      min_rows: 1, max_rows: 4, children: [
        { id: PRIVATE, type: 'file', label: 'Private proof', required: true,
          allowed_file_types: ['pdf'], public_access: false },
        { id: PUBLIC, type: 'file', label: 'Public photo',
          allowed_file_types: ['images'], public_access: true },
      ],
    }],
    pages: [], visibility_rules: [],
    entity_pipelines: { members: [], organisations: [] },
    structured_actions: { version: 1, actions: [] },
    require_authentication: false, access_policy: null,
    allow_save_continue_later: true, submit_button_text: 'Submit fixture',
    success_message: 'Fixture submitted', prefill_source: 'none',
    is_contract: false, blank_layout: true, survey_settings: {},
  };
}

async function installFixture(page, layout) {
  const state = {
    form: savedForm(layout), draft: null, savedForms: [],
    signed: [], uploaded: [], submissions: [], unexpected: [], pageErrors: [],
    failNextPut: false, holdNextPut: null,
  };
  page.on('pageerror', error => state.pageErrors.push(error.message));
  const origin = process.env.PLAYWRIGHT_BASE_URL || `https://${process.env.REPLIT_DEV_DOMAIN}`;

  // Fail closed for writes, and abort all off-origin traffic including legacy
  // direct Supabase calls. Static Vite source modules continue untouched.
  await page.context().route('**/*', route => {
    const request = route.request();
    if (new URL(request.url()).origin !== new URL(origin).origin) {
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
        state.unexpected.push(`${request.method()} external ${request.url()}`);
      }
      return route.abort();
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
      state.unexpected.push(`${request.method()} ${new URL(request.url()).pathname}`);
      return json(route, { error: 'Unrecognized fixture write' }, 599);
    }
    return route.continue();
  });
  await page.context().route('**/fixture-row-upload/*', async route => {
    const name = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop());
    state.uploaded.push(name);
    if (state.holdNextPut) {
      const release = state.holdNextPut;
      state.holdNextPut = null;
      await release;
    }
    if (state.failNextPut) {
      state.failNextPut = false;
      return json(route, { error: 'Fixture upload failure' }, 500);
    }
    return route.fulfill({ status: 200, body: '' });
  });
  await page.context().route('**/api/**', route => {
    const request = route.request();
    const { pathname, origin: requestOrigin, searchParams } = new URL(request.url());
    if (!pathname.startsWith('/api/')) return route.fallback();
    const method = request.method();
    const user = {
      id: '48200000-0000-4000-8000-000000000002',
      tenant_id: '48200000-0000-4000-8000-000000000003',
      role_id: '48200000-0000-4000-8000-000000000004',
      email: 'fixture@example.invalid',
    };
    const role = { id: user.role_id, tenant_id: user.tenant_id, name: 'Administrator', excluded_features: [] };
    if (pathname === '/api/auth/me') return json(route, {
      ...user, sessionRole: { status: 'ready', member_id: user.id,
        tenant_id: user.tenant_id, role_id: user.role_id, role },
    });
    if (pathname === '/api/auth/tenant-user-me') return json(route, { user, tenant: { id: user.tenant_id } });
    if (pathname === '/api/entities/Role') return json(route, [role]);
    if (pathname === `/api/entities/Role/${user.role_id}`) return json(route, role);
    if (pathname === '/api/entities/Form' && method === 'GET') return json(route, [state.form]);
    if (pathname === `/api/entities/Form/${FORM_ID}` && method === 'PATCH') {
      const patch = request.postDataJSON();
      state.savedForms.push(patch);
      state.form = { ...state.form, ...patch };
      return json(route, state.form);
    }
    if (pathname === `/api/public/form/${SLUG}` && method === 'GET') return json(route, state.form);
    if (pathname === '/api/public/form-draft' && method === 'POST') {
      state.draft = request.postDataJSON();
      return json(route, { success: true, resume_token: TOKEN });
    }
    if (pathname === '/api/public/form-draft' && method === 'GET') {
      if (searchParams.get('token') !== TOKEN || !state.draft) return json(route, { error: 'Draft not found' }, 404);
      return json(route, { success: true, draft: {
        draft_data: state.draft.draft_data, current_page_index: state.draft.current_page_index,
      } });
    }
    if (pathname === '/api/storage/signed-upload-url' && method === 'POST') {
      const payload = request.postDataJSON();
      state.signed.push(payload);
      // Explicitly distinguish public and private storage metadata; this
      // fixture tests the client payload, not server storage authorization.
      const fileUrl = payload.isPrivate
        ? `/api/storage/secure-url?bucket=private-uploads&path=${encodeURIComponent(`forms/${payload.fileName}`)}&redirect=true`
        : `${requestOrigin}/fixture-row-public/${encodeURIComponent(payload.fileName)}`;
      return json(route, {
        signedUrl: `${requestOrigin}/fixture-row-upload/${encodeURIComponent(payload.fileName)}`,
        fileUrl, path: `forms/${payload.fileName}`,
        bucket: payload.isPrivate ? 'private-uploads' : 'public-assets',
      });
    }
    if (pathname === '/api/public/form-submission' && method === 'POST') {
      state.submissions.push(request.postDataJSON());
      return json(route, { success: true, id: 'fixture-submission', submission_id: 'fixture-submission' });
    }
    if (pathname === '/api/public/form-payment-providers') return json(route, { providers: [] });
    if (pathname === '/api/public/form-consent-message') return json(route, { message: '' });
    if (pathname === '/api/public/tenant-branding') {
      return json(route, { success: true, branding: { name: 'Fixture', primaryColor: '#155e75' } });
    }
    if (pathname === '/api/public/navigation-items') return json(route, []);
    if (pathname === '/api/public/microsites') return json(route, { microsites: [] });
    if (pathname === '/api/public/resource-categories') return json(route, []);
    if (pathname === '/api/admin/integrations') return json(route, { integrations: [] });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      state.unexpected.push(`${method} ${pathname}`);
      return json(route, { error: `Unexpected API mutation: ${method} ${pathname}` }, 599);
    }
    return json(route, []);
  });
  return state;
}

const row = (page, index) => page.getByTestId(`repeatable-row-${SOURCE}-${index}`);
const fileInput = (scope, childId) => scope.locator(`input[type="file"][data-testid^="input-file-${childId}-"]`);
const upload = (scope, childId, name, mimeType) => fileInput(scope, childId).setInputFiles({
  name, mimeType, buffer: Buffer.from(mimeType === 'application/pdf' ? '%PDF-1.4 fixture' : 'fixture-image'),
});
const openForm = async page => {
  await page.goto(`/FormView?slug=${SLUG}`);
  await expect(page.getByTestId(`repeatable-rows-${SOURCE}`)).toBeVisible();
  const consent = page.getByRole('dialog', { name: 'Cookie consent' });
  if (await consent.isVisible()) await consent.getByRole('button', { name: 'Decline' }).click();
  if (await row(page, 0).count() === 0) {
    await page.getByTestId(`button-add-repeatable-row-${SOURCE}`).click();
  }
  await expect(row(page, 0)).toBeVisible();
};

for (const layout of ['cards', 'spreadsheet']) {
  test(`${layout}: saved file settings, independent row uploads, draft reload and submit`, async ({ page }) => {
    const state = await installFixture(page, layout);
    await page.goto(`/FormBuilder?formId=${FORM_ID}`);
    await page.getByTestId(`button-configure-field-${SOURCE}`).click();
    const privateSettings = page.getByTestId(`repeatable-child-${SOURCE}-0`);
    const publicSettings = page.getByTestId(`repeatable-child-${SOURCE}-1`);
    await expect(privateSettings.getByTestId(`select-repeatable-child-type-${SOURCE}-${PRIVATE}`)).toContainText(/File/i);
    await expect(privateSettings.getByTestId(`checkbox-repeatable-file-type-${SOURCE}-${PRIVATE}-pdf`)).toBeChecked();
    await expect(privateSettings.getByTestId(`checkbox-repeatable-public-access-${SOURCE}-${PRIVATE}`)).not.toBeChecked();
    await expect(publicSettings.getByTestId(`checkbox-repeatable-public-access-${SOURCE}-${PUBLIC}`)).toBeChecked();
    await expect(publicSettings.getByTestId(`checkbox-repeatable-file-type-${SOURCE}-${PUBLIC}-images`)).toBeChecked();
    await publicSettings.getByTestId(`checkbox-repeatable-public-access-${SOURCE}-${PUBLIC}`).click();
    await expect(publicSettings.getByTestId(`checkbox-repeatable-public-access-${SOURCE}-${PUBLIC}`)).not.toBeChecked();
    await publicSettings.getByTestId(`checkbox-repeatable-public-access-${SOURCE}-${PUBLIC}`).click();
    await expect(publicSettings.getByTestId(`checkbox-repeatable-public-access-${SOURCE}-${PUBLIC}`)).toBeChecked();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Save Form' }).click();
    await expect.poll(() => state.savedForms.length).toBe(1);
    expect(state.form.fields[0].children).toMatchObject([
      { type: 'file', allowed_file_types: ['pdf'], public_access: false },
      { type: 'file', allowed_file_types: ['images'], public_access: true },
    ]);
    await page.reload();
    await page.getByTestId(`button-configure-field-${SOURCE}`).click();
    await expect(page.getByTestId(`repeatable-child-${SOURCE}-1`)
      .getByTestId(`checkbox-repeatable-public-access-${SOURCE}-${PUBLIC}`)).toBeChecked();

    await openForm(page);
    await expect(row(page, 0)).toBeVisible();
    await expect(fileInput(row(page, 0), PRIVATE)).toHaveAttribute('accept', /\.pdf/);
    await expect(fileInput(row(page, 0), PUBLIC)).toHaveAttribute('accept', /\.png/);
    await upload(row(page, 0), PRIVATE, 'first.pdf', 'application/pdf');
    await expect(row(page, 0).getByText('first.pdf')).toBeVisible();
    await upload(row(page, 0), PUBLIC, 'first.png', 'image/png');
    await expect(row(page, 0).getByText('first.png')).toBeVisible();
    await page.getByTestId(`button-add-repeatable-row-${SOURCE}`).click();
    await upload(row(page, 1), PRIVATE, 'second.pdf', 'application/pdf');
    await expect(row(page, 1).getByText('second.pdf')).toBeVisible();
    expect(state.signed.map(item => [item.fileName, item.isPrivate, item.formId, item.type]))
      .toEqual([
        ['first.pdf', true, FORM_ID, 'form-submission'],
        ['first.png', false, FORM_ID, 'form-submission'],
        ['second.pdf', true, FORM_ID, 'form-submission'],
      ]);
    expect(state.uploaded).toEqual(['first.pdf', 'first.png', 'second.pdf']);

    await page.getByTestId('button-save-draft').click();
    await expect.poll(() => state.draft?.draft_data?.[SOURCE]?.length).toBe(2);
    const savedRows = state.draft.draft_data[SOURCE];
    expect(JSON.parse(savedRows[0][PRIVATE]).file_name).toBe('first.pdf');
    expect(JSON.parse(savedRows[1][PRIVATE]).file_name).toBe('second.pdf');
    expect(savedRows[0]._row_id).not.toBe(savedRows[1]._row_id);
    await page.goto(`/FormView?slug=${SLUG}&draft=${TOKEN}`);
    await expect(row(page, 0).getByText('first.pdf')).toBeVisible();
    await expect(row(page, 0).getByText('first.png')).toBeVisible();
    await expect(row(page, 1).getByText('second.pdf')).toBeVisible();
    await page.getByRole('button', { name: 'Submit fixture', exact: true }).click();
    await expect.poll(() => state.submissions.length).toBe(1);
    expect(state.submissions[0].submission_data[SOURCE]).toEqual(savedRows);
    expect(state.unexpected).toEqual([]);
    expect(state.pageErrors).toEqual([]);
  });

  test(`${layout}: failed upload cannot become an answer; late upload cannot move to another row`, async ({ page }) => {
    const state = await installFixture(page, layout);
    await openForm(page);
    await page.getByTestId(`button-add-repeatable-row-${SOURCE}`).click();
    state.failNextPut = true;
    await upload(row(page, 1), PRIVATE, 'failure.pdf', 'application/pdf');
    await expect(row(page, 1).getByRole('button', { name: /Private proof/ })).toBeVisible();
    await expect(row(page, 1).getByText('failure.pdf')).toHaveCount(0);

    let release;
    state.holdNextPut = new Promise(resolve => { release = resolve; });
    // setInputFiles resolves after the upload request completes; start it
    // without awaiting, then remove the row while its PUT is still pending.
    const selecting = upload(row(page, 1), PRIVATE, 'deleted.pdf', 'application/pdf');
    await expect.poll(() => state.uploaded.includes('deleted.pdf')).toBe(true);
    await expect(row(page, 1).getByText('Uploading...')).toBeVisible();
    await page.getByTestId(`button-remove-repeatable-row-${SOURCE}-1`).click();
    await expect(row(page, 1)).toHaveCount(0);
    await page.getByTestId(`button-add-repeatable-row-${SOURCE}`).click();
    release();
    await selecting;
    await expect(row(page, 1).getByRole('button', { name: /Private proof/ })).toBeVisible();
    await page.getByTestId('button-save-draft').click();
    await expect.poll(() => state.draft?.draft_data?.[SOURCE]?.length).toBe(2);
    expect(state.draft.draft_data[SOURCE][1][PRIVATE]).toBe('');
    expect(state.unexpected).toEqual([]);
    expect(state.pageErrors).toEqual([]);
  });
}