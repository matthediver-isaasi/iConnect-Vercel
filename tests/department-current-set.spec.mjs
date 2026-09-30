import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

// This is a browser-only, fully intercepted fixture.  It deliberately uses
// the live route components, rather than mounting a replacement form, while
// ensuring no current-set request can reach a real tenant or Supabase project.
const IDS = Object.freeze({
  tenant: 'ff2df806-b321-4254-b651-3af11fccf1db',
  form: '8b6f44d3-83f8-449e-9496-b10b1dc28e5f',
  department: 'cd1ebfd3-3e16-4091-be5a-99992d926f2f',
  member: '11111111-1111-4111-8111-111111111111',
  memberOrganization: '77777777-7777-4777-8777-777777777777',
  departmentOrganization: '88888888-8888-4888-8888-888888888888',
  type: '22222222-2222-4222-8222-222222222222',
  model: '33333333-3333-4333-8333-333333333333',
});
const SLUG = 'bnms-current-set-browser-fixture';
const WF = 'field_1788530969408';
const EQ = 'field_1789479861104';
const F = Object.freeze({
  staff: 'row_field_1788531041536_lih29',
  grade: 'row_field_1788531109823_jsmok',
  occupied: 'row_field_1788531209745_59bsx',
  vacant: 'row_field_1788531232436_3rjy1',
  type: 'row_field_1789479870791_pzi5h',
  manufacturer: 'row_field_1789479894031_n8x01',
  model: 'row_field_1789480125994_5lfxm',
  serial: 'row_field_1789639793360_0h7t0',
  installed: 'row_field_1789483471565_28vfi',
  decommissioned: 'row_field_1789483556749_2j3hp',
  inService: 'row_field_1789639334614_fwsk0',
  notes: 'row_field_1789484050588_qhn76',
});

const json = (route, body, status = 200) => route.fulfill({
  status, contentType: 'application/json', body: JSON.stringify(body),
});

function formFixture(layout = 'standard', multiColumn = false) {
  const text = (id, label, required = false) => ({ id, type: 'text', label, required });
  const fixture = {
    id: IDS.form, slug: SLUG, name: 'Maintain current Department data',
    description: 'Fixture only — current BNMS Department set.',
    is_active: true, require_authentication: true, form_type: 'application',
    layout_type: layout,
    pages: multiColumn ? [{ id: 'fixture-multi-column-page', title: 'Fixture multi-column page', column_count: 2 }] : [],
    visibility_rules: [], access: { allowed: true },
    current_set_enabled: true,
    current_set_configuration: {
      workforce_container_field_id: WF,
      equipment_container_field_id: EQ,
      equipment_existing_blank_required_field_ids: [F.serial, F.installed],
    },
    submit_button_text: 'Save current Department data',
    success_message: 'Current Department data saved.',
    entity_pipelines: { members: [], organisations: [] },
    structured_actions: { version: 1, actions: [] },
    fields: [{
      id: WF, type: 'repeatable_rows', label: 'Workforce', min_rows: 0, max_rows: 100,
      add_row_label: 'Add workforce row',
      children: [
        text(F.staff, 'Staff group', true), text(F.grade, 'Grade', true),
        { ...text(F.occupied, 'Occupied WTE', true), type: 'number' },
        { ...text(F.vacant, 'Vacant WTE', true), type: 'number' },
      ],
    }, {
      id: EQ, type: 'repeatable_rows', label: 'Equipment', min_rows: 0, max_rows: 100,
      add_row_label: 'Add equipment row',
      children: [
        { id: F.type, type: 'select', label: 'Type', required: true, options: [{ value: IDS.type, label: 'PET/CT' }] },
        { id: F.manufacturer, type: 'select', label: 'Manufacturer', required: true, options: ['Acme Medical'] },
        { id: F.model, type: 'select', label: 'Model', options: [{ value: IDS.model, label: 'Acme PET 1' }] },
        text(F.serial, 'Serial number', true),
        { id: F.installed, type: 'date', label: 'Installation year', required: true, date_precision: 'year' },
        // This mirrors the live BNMS form's historical metadata.  The date
        // child accidentally retained a stale options array ("YesNo"), even
        // though options are not meaningful for date fields.  A visible,
        // valid year must not be rejected as an invalid selection.
        { id: F.decommissioned, type: 'date', label: 'Decommissioning year', date_precision: 'year', options: ['YesNo'] },
        { id: F.inService, type: 'select', label: 'Still in service', required: true, options: ['Yes', 'No'] },
        text(F.notes, 'Additional information'),
      ],
    }],
  };
  if (multiColumn) {
    fixture.fields.push({
      id: 'fixture-page-assigned-text', type: 'text', label: 'Assigned fixture field',
      page_id: 'fixture-multi-column-page', column_index: 0,
    }, {
      id: 'fixture-unassigned-text', type: 'text', label: 'Unassigned fixture field',
    });
  }
  return fixture;
}

function currentSet(version = 'version-1', {
  incomplete = false,
  decommissionedVisible = false,
  invalidInService = false,
} = {}) {
  const equipment = Array.from({ length: 36 }, (_, index) => ({
    _row_id: `existing:equipment-${index}`,
    [F.type]: IDS.type,
    [F.manufacturer]: 'Acme Medical',
    [F.model]: IDS.model,
    [F.serial]: index === 0 ? '' : `SN-${index}`,
    [F.installed]: index === 0 ? '' : '2020',
    [F.decommissioned]: index === 0 ? '' : '2025',
    [F.inService]: invalidInService && index === 2
      ? 'Maybe'
      : (decommissionedVisible && index === 2 ? 'No' : 'Yes'),
    [F.notes]: index === 0 ? 'Legacy blank serial and year are permitted.' : '',
  }));
  return {
    department: { id: IDS.department, label: 'Radiology — North' },
    // Deliberately differs from the member's organisation. The identity must
    // come from the authorised Department load, never from auth-member data.
    organization: {
      status: 'available',
      id: IDS.departmentOrganization,
      name: 'North Coast Imaging Trust',
    },
    department_id: IDS.department,
    version,
    complete_sections: incomplete ? [WF] : [WF, EQ],
    form_values: {
      [WF]: [{
        _row_id: 'existing:workforce-1',
        [F.staff]: 'Clinical Practitioner – Technologist ',
        [F.grade]: 'Band 8a',
        [F.occupied]: 0,
        [F.vacant]: 1.5,
      }],
      ...(incomplete ? {} : { [EQ]: equipment }),
      __department_current_set: {
        department_id: IDS.department, version, complete_sections: incomplete ? [WF] : [WF, EQ],
      },
    },
    option_labels: {
      [EQ]: {
        [F.type]: [{ id: IDS.type, label: 'PET/CT' }],
        [F.manufacturer]: [{ id: 'Acme Medical', label: 'Acme Medical' }],
        [F.model]: [{ id: IDS.model, label: 'Acme PET 1' }],
      },
    },
  };
}

function iEditPageFixture() {
  return {
    page: {
      id: 'current-set-iedit', slug: 'department-current-set-iedit', name: 'Current set iEdit page',
      status: 'published', builder_type: 'iedit', public_chrome: 'none',
    },
    elements: [{
      id: 'current-set-iedit-form', page_id: 'current-set-iedit', element_type: 'form', display_order: 1,
      content: { form_slug: SLUG },
    }],
    symbols: [],
  };
}

function canvasPageFixture() {
  return {
    page: {
      id: 'current-set-canvas', slug: 'department-current-set-canvas', name: 'Current set Canvas page',
      status: 'published', builder_type: 'canvas', public_chrome: 'none',
      canvas_design: {
        version: 1,
        root: { sections: [{ id: 'fixture-section', children: [{
          id: 'fixture-canvas-form', type: 'form-embed',
          geom: { x: 0, y: 0, w: 1100, h: 1200 },
          bp: { desktop: { x: 0, y: 0, w: 1100, h: 1200 } },
          content: { formSlug: SLUG, mode: 'iframe', title: 'Current Department form' },
        }] }] },
      },
    },
    elements: [], symbols: [],
  };
}

async function install(page, {
  current = currentSet(),
  currentStatus = 200,
  departments = [{ id: IDS.department, label: 'Radiology — North' }],
  delayed = false,
  submitStatus = 200,
  layout = 'standard',
  multiColumn = false,
  committed = true,
} = {}) {
  const state = {
    submissions: [], drafts: [], submissionPaths: [], postSubmissionEffects: [], unexpectedWrites: [], pageErrors: [],
    currentRequests: 0, optionRequests: 0,
  };
  page.on('pageerror', error => state.pageErrors.push(error.message));
  const appOrigin = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:5000';

  await page.context().route('**/*', route => {
    const request = route.request();
    if (new URL(request.url()).origin !== new URL(appOrigin).origin) return route.abort();
    return route.continue();
  });
  await page.context().route(/\/(?:rest|auth)\/v1\//, route => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(route.request().method())) {
      state.unexpectedWrites.push(`Supabase ${route.request().method()} ${route.request().url()}`);
      return json(route, { error: 'No fixture permits a mutation' }, 599);
    }
    return json(route, []);
  });
  await page.context().route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (!path.startsWith('/api/')) return route.continue();
    if (path === '/api/auth/me' && method === 'GET') {
      return json(route, {
        id: IDS.member, tenant_id: IDS.tenant, email: 'respondent@example.test',
        first_name: 'Current', last_name: 'Respondent',
        organization_id: IDS.memberOrganization, organization_name: 'Respondent Home Organisation',
        member_excluded_features: [],
      });
    }
    if (path === '/api/auth/tenant-user-me' && method === 'GET') return json(route, { user: null }, 401);
    if (path === `/api/public/form/${SLUG}` && method === 'GET') return json(route, formFixture(layout, multiColumn));
    if (path === '/api/public/form/current-set' && method === 'GET') {
      expect(url.searchParams.get('form_id')).toBe(IDS.form);
      if (!url.searchParams.has('department_id')) {
        state.optionRequests++;
        return json(route, { departments });
      }
      state.currentRequests++;
      expect(url.searchParams.get('department_id')).toBe(IDS.department);
      if (delayed) await new Promise(resolve => setTimeout(resolve, 300));
      return json(route, current, currentStatus);
    }
    if (path === '/api/public/form-draft' && method === 'POST') {
      const body = request.postDataJSON();
      state.drafts.push(body);
      return json(route, { success: true, resume_token: 'fixture-resume-token' });
    }
    if (path === '/api/public/form-submission' && method === 'POST') {
      const body = request.postDataJSON();
      state.submissions.push(body);
      state.submissionPaths.push(path);
      return submitStatus === 409
        ? json(route, { error: 'Current Department data changed; reload and review it before saving', code: 'CURRENT_SET_CONFLICT' }, 409)
        : json(route, committed
          ? {
            success: true, id: 'submission-1', submission_id: 'submission-1',
            current_set: { status: 'committed', version: 'version-2' },
          }
          : { success: true, id: 'submission-1', submission_id: 'submission-1' });
    }
    if (path === '/api/public/page/department-current-set-iedit' && method === 'GET') {
      return json(route, iEditPageFixture());
    }
    if (path === '/api/public/page/department-current-set-canvas' && method === 'GET') {
      return json(route, canvasPageFixture());
    }
    // These are established, post-commit client notifications. They are
    // deliberately intercepted and recorded (never allowed onto a real API).
    if (path === `/api/entities/Form/${IDS.form}` && method === 'PATCH') {
      state.postSubmissionEffects.push(`${method} ${path}`);
      return json(route, { success: true });
    }
    if (path === '/api/forms/send-submission-email' && method === 'POST') {
      state.postSubmissionEffects.push(`${method} ${path}`);
      return json(route, { success: true });
    }
    if (path === '/api/public/microsites' && method === 'GET') return json(route, { microsites: [] });
    if (['/api/public/tenant-branding', '/api/public/navigation-items', '/api/public/banners',
      '/api/public/social-icons', '/api/public/header-icons', '/api/public/configs'].includes(path)) return json(route, []);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      state.unexpectedWrites.push(`${method} ${path}`);
      return json(route, { error: 'Unexpected fixture write' }, 599);
    }
    return json(route, []);
  });
  return state;
}

function row(surface, container, index) {
  return surface.getByTestId(`repeatable-row-${container}-${index}`);
}

async function acknowledge(surface) {
  await surface.getByTestId('acknowledge-current-workforce').click();
  await surface.getByTestId('acknowledge-current-equipment').click();
}

async function dismissCookie(page) {
  const consent = page.getByRole('dialog', { name: 'Cookie consent' });
  if (await consent.isVisible().catch(() => false)) {
    await consent.getByRole('button', { name: /decline/i }).click();
  }
}

async function assertLoaded(surface) {
  await assertIdentity(surface);
  await expect(surface.getByTestId('department-current-set-review')).toContainText('Radiology — North');
  await expect(row(surface, WF, 0).locator('input').first()).toHaveValue('Clinical Practitioner – Technologist ');
  await expect(surface.getByTestId(`repeatable-row-${EQ}-35`)).toBeVisible();
  await expect(surface.getByText('36 of 100 rows')).toBeVisible();
  await expect(row(surface, EQ, 0).getByRole('combobox').nth(0)).toContainText(/PET\/CT/);
  await expect(row(surface, EQ, 0).getByRole('combobox').nth(1)).toContainText(/Acme Medical/);
  await expect(row(surface, EQ, 0).getByRole('combobox').nth(2)).toContainText(/Acme PET 1/);
}

async function assertCardLoaded(surface) {
  await assertIdentity(surface);
  await expect(surface.getByTestId('department-current-set-review')).toContainText('Radiology — North');
  await expect(row(surface, WF, 0).locator('input').first()).toHaveValue('Clinical Practitioner – Technologist ');
  await surface.getByRole('button', { name: 'Next', exact: true }).click();
  // Identity remains visible while respondents navigate between answer pages.
  await assertIdentity(surface);
  await expect(surface.getByTestId(`repeatable-row-${EQ}-35`)).toBeVisible();
  await expect(surface.getByText('36 of 100 rows')).toBeVisible();
  await expect(row(surface, EQ, 0).getByRole('combobox').nth(0)).toContainText(/PET\/CT/);
}

async function assertIdentity(surface) {
  const identity = surface.getByTestId('department-current-set-identity');
  await expect(identity).toBeVisible();
  await expect(identity.getByText('Organisation', { exact: true })).toBeVisible();
  await expect(identity.getByText('North Coast Imaging Trust', { exact: true })).toBeVisible();
  await expect(identity.getByText('Department', { exact: true })).toBeVisible();
  await expect(identity.getByText('Radiology — North', { exact: true })).toBeVisible();
  await expect(identity).not.toContainText('Respondent Home Organisation');
  await expect(surface.locator('[data-testid^="repeatable-row-"]').first()).toBeVisible();
  expect(await identity.evaluate(element => {
    const firstAnswer = element.ownerDocument.querySelector('[data-testid^="repeatable-row-"]');
    return !!firstAnswer && !!(element.compareDocumentPosition(firstAnswer) & Node.DOCUMENT_POSITION_FOLLOWING);
  })).toBe(true);
}

test('standalone current-set prefill retains all rows, legacy values, and submits complete reconciliation', async ({ page }, testInfo) => {
  const state = await install(page, { delayed: true });
  await page.goto(`/FormView?slug=${SLUG}&department_id=${IDS.department}&tenant=bnms-fixture`);
  await expect(page.getByTestId('department-current-set-loading')).toBeVisible();
  await expect(page.getByTestId('department-current-set-identity')).toHaveCount(0);
  // A standard-layout FormView must expose both the current-set review and
  // acknowledgements; without them it can never safely submit this form.
  await assertLoaded(page);

  // Existing blank required cells remain renderable and do not prevent a
  // complete review/save.  Delete one existing row, add then remove a new row:
  // identities must remain stable and the full set is still submitted.
  await expect(row(page, EQ, 0).locator('input').nth(0)).toHaveValue('');
  await expect(row(page, EQ, 0).locator('input').nth(1)).toHaveValue('');
  await page.getByTestId(`button-remove-repeatable-row-${EQ}-35`).click();
  await page.getByTestId(`button-add-repeatable-row-${EQ}`).click();
  await expect(page.getByTestId(`repeatable-row-${EQ}-35`)).toBeVisible();
  await page.getByTestId(`button-remove-repeatable-row-${EQ}-35`).click();
  await acknowledge(page);
  await page.getByRole('button', { name: 'Save current Department data', exact: true }).click();
  await expect.poll(() => state.submissions.length).toBe(1);
  const submitted = state.submissions[0].submission_data;
  expect(submitted.__department_current_set).toEqual({
    department_id: IDS.department, version: 'version-1', complete_sections: [WF, EQ],
  });
  expect(submitted[WF][0]._row_id).toBe('existing:workforce-1');
  expect(submitted[WF][0][F.staff]).toBe('Clinical Practitioner – Technologist ');
  expect(submitted[WF][0][F.occupied]).toBe(0);
  expect(submitted[EQ]).toHaveLength(35);
  expect(submitted[EQ][0]._row_id).toBe('existing:equipment-0');
  expect(submitted[EQ][0][F.serial]).toBe('');
  expect(submitted).not.toHaveProperty('organization');
  expect(submitted).not.toHaveProperty('department');
  await mkdir('screenshots/department-current-set', { recursive: true });
  await page.screenshot({ path: 'screenshots/department-current-set/standalone-committed.png', fullPage: true });
  expect(state.currentRequests).toBe(1);
  expect(state.unexpectedWrites).toEqual([]);
  expect(state.pageErrors).toEqual([]);
});

const pickerSurfaces = [
  {
    name: 'standalone desktop',
    href: `/FormView?slug=${SLUG}&tenant=bnms-fixture`,
    surface: page => page,
  },
  {
    name: 'embedded mobile',
    href: `/embed/form/${SLUG}?tenant=bnms-fixture`,
    mobile: true,
    surface: page => page,
  },
  {
    name: 'iEdit desktop',
    href: '/department-current-set-iedit?tenant=bnms-fixture',
    surface: page => page,
  },
  {
    name: 'Canvas mobile',
    href: '/department-current-set-canvas?tenant=bnms-fixture',
    mobile: true,
    surface: page => page.frameLocator('[data-testid="iframe-form-embed"]'),
  },
];

for (const pickerCase of pickerSurfaces) {
  test(`${pickerCase.name} picker shows authorised Workforce Survey identity before answers`, async ({ page }) => {
    if (pickerCase.mobile) await page.setViewportSize({ width: 390, height: 844 });
    const state = await install(page);
    await page.goto(pickerCase.href);
    await dismissCookie(page);
    const surface = pickerCase.surface(page);
    const picker = surface.getByTestId('department-current-set-picker');
    await expect(picker).toBeVisible();
    await picker.getByRole('combobox').selectOption(IDS.department);

    // Assert identity before inspecting any prefilled answer. This catches
    // surfaces that render the identity too late or only on an answer page.
    await assertIdentity(surface);
    await expect(row(surface, WF, 0).locator('input').first())
      .toHaveValue('Clinical Practitioner – Technologist ');
    expect(state.optionRequests).toBe(1);
    expect(state.currentRequests).toBe(1);
    expect(state.unexpectedWrites).toEqual([]);
    expect(state.pageErrors).toEqual([]);
  });
}

test('successful load with missing Organisation identity is explicit and never guesses from the member', async ({ page }) => {
  const withoutOrganization = currentSet();
  withoutOrganization.organization = { status: 'unavailable' };
  const state = await install(page, { current: withoutOrganization });
  await page.goto(`/FormView?slug=${SLUG}&department_id=${IDS.department}&tenant=bnms-fixture`);
  await dismissCookie(page);

  const identity = page.getByTestId('department-current-set-identity');
  await expect(identity).toBeVisible();
  await expect(identity.getByText('Organisation unavailable', { exact: true })).toBeVisible();
  await expect(identity.getByText('Department', { exact: true })).toBeVisible();
  await expect(identity.getByText('Radiology — North', { exact: true })).toBeVisible();
  await expect(identity).not.toContainText('Respondent Home Organisation');
  await expect(identity).not.toContainText('North Coast Imaging Trust');
  expect(state.unexpectedWrites).toEqual([]);
});

for (const deniedCase of [
  { name: 'failed', status: 503, error: 'Fixture current set unavailable' },
  { name: 'denied', status: 403, error: 'You do not have access to this Department' },
]) {
  test(`${deniedCase.name} current-set load exposes no Workforce Survey identity names`, async ({ page }) => {
    const state = await install(page, {
      currentStatus: deniedCase.status,
      current: {
        error: deniedCase.error,
        department: { id: IDS.department, label: 'Secret Department Name' },
        organization: {
          status: 'available',
          id: IDS.departmentOrganization,
          name: 'Secret Organisation Name',
        },
      },
    });
    await page.goto(`/FormView?slug=${SLUG}&department_id=${IDS.department}&tenant=bnms-fixture`);
    await dismissCookie(page);
    await expect(page.getByTestId('department-current-set-error')).toBeVisible();
    await expect(page.getByTestId('department-current-set-identity')).toHaveCount(0);
    await expect(page.getByText('Secret Department Name')).toHaveCount(0);
    await expect(page.getByText('Secret Organisation Name')).toHaveCount(0);
    await expect(page.getByText('North Coast Imaging Trust')).toHaveCount(0);
    expect(state.submissions).toEqual([]);
    expect(state.unexpectedWrites).toEqual([]);
  });
}

test('identity display does not alter draft or save payload contracts', async ({ page }) => {
  const state = await install(page);
  await page.goto(`/FormView?slug=${SLUG}&department_id=${IDS.department}&tenant=bnms-fixture`);
  await dismissCookie(page);
  await assertLoaded(page);

  await page.getByTestId('button-save-draft').click();
  await expect.poll(() => state.drafts.length).toBe(1);
  expect(state.drafts[0].draft_data.__department_current_set).toEqual({
    department_id: IDS.department,
    version: 'version-1',
    complete_sections: [WF, EQ],
  });
  expect(state.drafts[0].draft_data).not.toHaveProperty('organization');
  expect(state.drafts[0].draft_data).not.toHaveProperty('department');

  await acknowledge(page);
  await page.getByRole('button', { name: 'Save current Department data', exact: true }).click();
  await expect.poll(() => state.submissions.length).toBe(1);
  expect(state.submissions[0].submission_data.__department_current_set).toEqual(
    state.drafts[0].draft_data.__department_current_set,
  );
  expect(state.submissions[0].submission_data).not.toHaveProperty('organization');
  expect(state.submissions[0].submission_data).not.toHaveProperty('department');
  expect(state.unexpectedWrites).toEqual([]);
});

test('live date metadata does not reject a visible decommissioning year, while invalid select values remain blocked', async ({ page }) => {
  const state = await install(page, {
    current: currentSet('version-1', { decommissionedVisible: true }),
  });
  await page.goto(`/FormView?slug=${SLUG}&department_id=${IDS.department}&tenant=bnms-fixture`);
  await assertLoaded(page);

  // Row 2 is the live-shaped case: the decommissioning date is visible and
  // valid while the date field still carries stale ["YesNo"] options.
  await expect(row(page, EQ, 2).locator('input').nth(2)).toHaveValue('2025');
  await acknowledge(page);
  await page.getByRole('button', { name: 'Save current Department data', exact: true }).click();
  await expect.poll(() => state.submissions.length).toBe(1);
  expect(state.submissions[0].submission_data[EQ][2][F.decommissioned]).toBe('2025');
  expect(state.unexpectedWrites).toEqual([]);

  // A genuinely invalid select value must still fail closed; this guards
  // against fixing date metadata by weakening selection validation globally.
  const invalidState = await install(page, {
    current: currentSet('version-1', { invalidInService: true }),
  });
  await page.goto(`/FormView?slug=${SLUG}&department_id=${IDS.department}&tenant=bnms-fixture`);
  await assertLoaded(page);
  await acknowledge(page);
  await page.getByRole('button', { name: 'Save current Department data', exact: true }).click();
  await expect(page.getByText('Please fix validation errors: Equipment')).toBeVisible();
  expect(invalidState.submissions).toEqual([]);
  expect(invalidState.unexpectedWrites).toEqual([]);
});

test('both acknowledgements permit a deliberate empty Equipment set', async ({ page }) => {
  const state = await install(page);
  await page.goto(`/FormView?slug=${SLUG}&department_id=${IDS.department}&tenant=bnms-fixture`);
  await dismissCookie(page);
  await assertLoaded(page);

  // This must use the real removal controls: an empty array is only safe after
  // the browser has loaded the entire authoritative set and both reviews are
  // deliberately acknowledged.
  for (let index = 0; index < 36; index += 1) {
    await page.getByTestId(`button-remove-repeatable-row-${EQ}-0`).click();
  }
  await expect(page.getByTestId(`repeatable-row-${EQ}-0`)).toHaveCount(0);
  await expect(page.getByText('0 of 100 rows')).toBeVisible();
  await acknowledge(page);
  await page.getByRole('button', { name: 'Save current Department data', exact: true }).click();
  await expect.poll(() => state.submissions.length).toBe(1);
  expect(state.submissions[0].submission_data[EQ]).toEqual([]);
  expect(state.submissions[0].submission_data.__department_current_set).toEqual({
    department_id: IDS.department, version: 'version-1', complete_sections: [WF, EQ],
  });
  expect(state.unexpectedWrites).toEqual([]);
  expect(state.pageErrors).toEqual([]);
});

test('embedded and iEdit surfaces use the same authorized prefill and complete payload', async ({ page }, testInfo) => {
  const state = await install(page, { layout: 'card_swipe' });
  await page.goto(`/embed/form/${SLUG}?department_id=${IDS.department}&tenant=bnms-fixture`);
  await dismissCookie(page);
  await assertCardLoaded(page);
  await mkdir('screenshots/department-current-set', { recursive: true });
  await page.screenshot({ path: 'screenshots/department-current-set/embed-prefill.png', fullPage: true });
  await acknowledge(page);
  await page.getByRole('button', { name: 'Save current Department data', exact: true }).click();
  await expect.poll(() => state.submissions.length).toBe(1);

  const iedit = await page.context().newPage();
  await iedit.goto(`/department-current-set-iedit?department_id=${IDS.department}&tenant=bnms-fixture`);
  await dismissCookie(iedit);
  // IEdit uses its shared page paginator even when the form schema's layout is
  // standard, so the Equipment container is on the second rendered page.
  await assertCardLoaded(iedit);
  await acknowledge(iedit);
  await iedit.getByRole('button', { name: 'Save current Department data', exact: true }).click();
  await expect.poll(() => state.submissions.length).toBe(2);
  expect(state.submissionPaths).toEqual(['/api/public/form-submission', '/api/public/form-submission']);
  expect(state.submissions[1].submission_data.__department_current_set.complete_sections).toEqual([WF, EQ]);
  await iedit.screenshot({ path: 'screenshots/department-current-set/iedit-committed.png', fullPage: true });
  expect(state.unexpectedWrites).toEqual([]);
  expect(state.pageErrors).toEqual([]);
  await iedit.close();
});

for (const surface of ['standalone', 'embed', 'iedit']) {
  test(`${surface} rejects a 200 response that lacks a committed current-set marker`, async ({ page }) => {
    const cardSurface = surface !== 'standalone';
    const state = await install(page, { layout: cardSurface ? 'card_swipe' : 'standard', committed: false });
    const href = surface === 'standalone'
      ? `/FormView?slug=${SLUG}&department_id=${IDS.department}&tenant=bnms-fixture`
      : surface === 'embed'
        ? `/embed/form/${SLUG}?department_id=${IDS.department}&tenant=bnms-fixture`
        : `/department-current-set-iedit?department_id=${IDS.department}&tenant=bnms-fixture`;
    await page.goto(href);
    await dismissCookie(page);
    if (cardSurface) await assertCardLoaded(page);
    else await assertLoaded(page);
    await acknowledge(page);
    await page.getByRole('button', { name: 'Save current Department data', exact: true }).click();
    await expect.poll(() => state.submissions.length).toBe(1);
    await expect(page.getByText(/has not been confirmed as saved.*retry or reload/i).first()).toBeVisible();
    await expect(page.getByText('Current Department data saved.')).toHaveCount(0);
    expect(state.submissionPaths).toEqual(['/api/public/form-submission']);
    expect(state.unexpectedWrites).toEqual([]);
    expect(state.pageErrors).toEqual([]);
  });
}

test('iEdit standard multi-column page renders unassigned current-set fields without a runtime error', async ({ page }) => {
  const state = await install(page, { multiColumn: true });
  await page.goto(`/department-current-set-iedit?department_id=${IDS.department}&tenant=bnms-fixture`);
  await dismissCookie(page);
  await expect(page.getByTestId('department-current-set-review')).toBeVisible();
  // This specifically enters IEditFormElement's `unassignedFields.map`
  // branch, where the equipment legacy-blank map must use `field.id`.
  await expect(page.getByText('Unassigned fixture field')).toBeVisible();
  await expect(page.getByTestId(`repeatable-row-${EQ}-35`)).toBeVisible();
  expect(state.currentRequests).toBeGreaterThanOrEqual(1);
  expect(state.unexpectedWrites).toEqual([]);
  expect(state.pageErrors).toEqual([]);
});

test('Canvas iframe forwards only the valid Department context into the real embedded form', async ({ page }) => {
  const state = await install(page, { layout: 'card_swipe' });
  await page.goto(`/department-current-set-canvas?department_id=${IDS.department}&tenant=bnms-fixture`);
  await dismissCookie(page);
  const iframe = page.getByTestId('iframe-form-embed');
  await expect(iframe).toBeVisible();
  const surface = page.frameLocator('[data-testid="iframe-form-embed"]');
  await assertCardLoaded(surface);
  await acknowledge(surface);
  await surface.getByRole('button', { name: 'Save current Department data', exact: true }).click();
  await expect.poll(() => state.submissions.length).toBe(1);
  expect(state.submissions[0].submission_data.__department_current_set).toEqual({
    department_id: IDS.department, version: 'version-1', complete_sections: [WF, EQ],
  });
  await mkdir('screenshots/department-current-set', { recursive: true });
  await page.screenshot({ path: 'screenshots/department-current-set/canvas-prefill.png', fullPage: true });
  expect(state.currentRequests).toBe(1);
  expect(state.unexpectedWrites).toEqual([]);
  expect(state.pageErrors).toEqual([]);
});

test('incomplete or conflicted current-set reads never become destructive successful saves', async ({ page }) => {
  const incomplete = await install(page, { current: currentSet('version-1', { incomplete: true }) });
  await page.goto(`/FormView?slug=${SLUG}&department_id=${IDS.department}&tenant=bnms-fixture`);
  await dismissCookie(page);
  await expect(page.getByTestId('department-current-set-error')).toContainText(/incomplete|reload/i);
  await expect(page.getByRole('button', { name: 'Save current Department data', exact: true })).toBeDisabled();
  expect(incomplete.submissions).toHaveLength(0);
  expect(incomplete.unexpectedWrites).toEqual([]);

  const unavailablePage = await page.context().newPage();
  const unavailable = await install(unavailablePage, {
    current: { error: 'Fixture current set unavailable' }, currentStatus: 503,
  });
  await unavailablePage.goto(`/FormView?slug=${SLUG}&department_id=${IDS.department}&tenant=bnms-fixture`);
  await dismissCookie(unavailablePage);
  await expect(unavailablePage.getByTestId('department-current-set-error')).toContainText(/could not be loaded|unavailable|reload/i);
  await expect(unavailablePage.getByRole('button', { name: 'Save current Department data', exact: true })).toBeDisabled();
  expect(unavailable.submissions).toHaveLength(0);
  expect(unavailable.unexpectedWrites).toEqual([]);
  await unavailablePage.close();

  const conflictPage = await page.context().newPage();
  const conflict = await install(conflictPage, { submitStatus: 409, layout: 'card_swipe' });
  await conflictPage.goto(`/embed/form/${SLUG}?department_id=${IDS.department}&tenant=bnms-fixture`);
  await dismissCookie(conflictPage);
  await assertCardLoaded(conflictPage);
  await acknowledge(conflictPage);
  await conflictPage.getByRole('button', { name: 'Save current Department data', exact: true }).click();
  await expect.poll(() => conflict.submissions.length).toBe(1);
  await expect(conflictPage.getByText(/changed.*reload|reload.*review/i)).toBeVisible();
  await expect(conflictPage.getByText('Current Department data saved.')).toHaveCount(0);
  expect(conflict.unexpectedWrites).toEqual([]);
  expect(conflict.pageErrors).toEqual([]);
  await conflictPage.close();
});