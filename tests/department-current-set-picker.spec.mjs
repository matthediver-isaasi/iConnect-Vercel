import { test, expect } from '@playwright/test';

// This spec intentionally stays read-only: every API request used by the
// browser is intercepted below and no Supabase/auth session is created.
// The committed current-set surface smoke tests cover IEdit/Canvas as well;
// this focused spec covers the picker and the hook's identity transitions.
const IDS = Object.freeze({
  tenant: 'ff2df806-b321-4254-b651-3af11fccf1db',
  form: '8b6f44d3-83f8-449e-9496-b10b1dc28e5f',
  departmentA: 'cd1ebfd3-3e16-4091-be5a-99992d926f2f',
  departmentB: 'dd2ebfd3-3e16-4091-be5a-99992d926f2f',
  memberA: '11111111-1111-4111-8111-111111111111',
  memberB: '44444444-4444-4444-8444-444444444444',
});
const SLUG = 'bnms-current-set-picker-browser-fixture';
const WF = 'field_1788530969408';
const EQ = 'field_1789479861104';
const UNRELATED = 'fixture-unrelated-answer';
const STAFF = 'row_field_1788531041536_lih29';
const EQUIPMENT = 'row_field_1789479894031_n8x01';

const json = (route, body, status = 200) => route.fulfill({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
});

const textField = (id, label, required = false) => ({
  id,
  type: 'text',
  label,
  required,
});

function formFixture() {
  return {
    id: IDS.form,
    slug: SLUG,
    name: 'Maintain current Department data',
    description: 'Read-only browser fixture.',
    is_active: true,
    require_authentication: false,
    form_type: 'application',
    layout_type: 'standard',
    pages: [],
    visibility_rules: [],
    access: { allowed: true },
    current_set_enabled: true,
    current_set_configuration: {
      workforce_container_field_id: WF,
      equipment_container_field_id: EQ,
    },
    submit_button_text: 'Save current Department data',
    fields: [
      {
        id: WF,
        type: 'repeatable_rows',
        label: 'Workforce',
        min_rows: 0,
        max_rows: 20,
        add_row_label: 'Add workforce row',
        children: [textField(STAFF, 'Staff group', true)],
      },
      {
        id: EQ,
        type: 'repeatable_rows',
        label: 'Equipment',
        min_rows: 0,
        max_rows: 20,
        add_row_label: 'Add equipment row',
        children: [textField(EQUIPMENT, 'Manufacturer', true)],
      },
      textField(UNRELATED, 'Unrelated answer'),
    ],
  };
}

function currentSet(departmentId, label, version) {
  return {
    department: { id: departmentId, label },
    department_id: departmentId,
    version,
    complete_sections: [WF, EQ],
    form_values: {
      [WF]: [{ _row_id: `existing:${departmentId}:workforce`, [STAFF]: `${label} workforce` }],
      [EQ]: [{ _row_id: `existing:${departmentId}:equipment`, [EQUIPMENT]: `${label} equipment` }],
      __department_current_set: {
        department_id: departmentId,
        version,
        complete_sections: [WF, EQ],
      },
    },
  };
}

async function install(page, {
  currentStatus = 200,
  currentBody = null,
  optionsStatus = 200,
  optionsBody = null,
  member = 'a',
} = {}) {
  const state = {
    currentRequests: [],
    unexpectedWrites: [],
    pageErrors: [],
    currentMember: member === null ? null : member === 'b' ? IDS.memberB : IDS.memberA,
  };
  const appOrigin = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:5000';

  page.on('pageerror', error => state.pageErrors.push(error.message));
  await page.context().route('**/*', route => {
    const request = route.request();
    if (new URL(request.url()).origin !== new URL(appOrigin).origin) return route.abort();
    return route.continue();
  });
  await page.context().route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    // The Vite source graph contains paths such as /src/api/base44Client.js.
    // Only intercept actual API requests; returning JSON for source modules
    // leaves the app blank before the form can render.
    if (!path.startsWith('/api/')) return route.continue();

    if (path === '/api/auth/me' && method === 'GET') {
      if (!state.currentMember) return json(route, { error: 'Signed out' }, 401);
      return json(route, {
        id: state.currentMember,
        tenant_id: IDS.tenant,
        email: state.currentMember === IDS.memberB ? 'member-b@example.test' : 'member-a@example.test',
        first_name: 'Fixture',
        last_name: 'Respondent',
        member_excluded_features: [],
      });
    }
    if (path === '/api/auth/tenant-user-me' && method === 'GET') return json(route, { user: null }, 401);
    if (path === `/api/public/form/${SLUG}` && method === 'GET') return json(route, formFixture());
    if (path === '/api/public/form/current-set' && method === 'GET') {
      const departmentId = url.searchParams.get('department_id');
      state.currentRequests.push({ departmentId, member: state.currentMember });
      if (!departmentId) {
        return json(route, optionsBody ?? {
          departments: [
            { id: IDS.departmentA, label: 'Radiology — North' },
            { id: IDS.departmentB, label: 'Radiology — South' },
          ],
        }, optionsStatus);
      }
      if (currentBody) return json(route, currentBody, currentStatus);
      return json(route, departmentId === IDS.departmentB
        ? currentSet(IDS.departmentB, 'Radiology — South', 'version-b')
        : currentSet(IDS.departmentA, 'Radiology — North', 'version-a'), currentStatus);
    }
    if (path === '/api/public/tenant-branding' && method === 'GET') return json(route, { success: true, branding: {} });
    if (path === '/api/public/form-consent-message' && method === 'GET') return json(route, {});
    if (path === '/api/public/microsites' && method === 'GET') return json(route, { microsites: [] });
    if (['/api/public/navigation-items', '/api/public/banners', '/api/public/social-icons',
      '/api/public/header-icons', '/api/public/configs'].includes(path)) return json(route, []);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      state.unexpectedWrites.push(`${method} ${path}`);
      return json(route, { error: 'Fixture is read-only' }, 599);
    }
    return json(route, []);
  });
  return state;
}

async function dismissCookie(page) {
  const consent = page.getByRole('dialog', { name: 'Cookie consent' });
  if (await consent.isVisible().catch(() => false)) {
    await consent.getByRole('button', { name: /decline/i }).click();
  }
}

async function expectLoadedRows(surface, label) {
  await expect(surface.getByTestId('department-current-set-review')).toContainText(label);
  // Input values are not part of fieldset textContent.
  await expect(surface.getByTestId(`repeatable-row-${WF}-0`).locator('input').first())
    .toHaveValue(`${label} workforce`);
  await expect(surface.getByTestId(`repeatable-row-${EQ}-0`).locator('input').first())
    .toHaveValue(`${label} equipment`);
}

test('FormView picker selects an assigned Department and renders Workforce/Equipment rows', async ({ page }) => {
  const state = await install(page);
  await page.goto(`/FormView?slug=${SLUG}&tenant=bnms-fixture`);
  await dismissCookie(page);

  const picker = page.getByTestId('department-current-set-picker');
  await expect(picker).toBeVisible();
  await expect(picker.locator('option')).toHaveCount(3);
  await picker.locator('select').selectOption(IDS.departmentA);
  await expectLoadedRows(page, 'Radiology — North');
  expect(state.currentRequests.map(request => request.departmentId)).toContain(IDS.departmentA);
  expect(state.unexpectedWrites).toEqual([]);
  expect(state.pageErrors).toEqual([]);
});

test('embed form renders the same loaded repeatable current-set rows', async ({ page }) => {
  const state = await install(page);
  await page.goto(`/embed/form/${SLUG}?department_id=${IDS.departmentB}&tenant=bnms-fixture`);
  await dismissCookie(page);
  await expectLoadedRows(page, 'Radiology — South');
  expect(state.currentRequests).toEqual([
    { departmentId: IDS.departmentB, member: IDS.memberA },
  ]);
  expect(state.unexpectedWrites).toEqual([]);
  expect(state.pageErrors).toEqual([]);
});

test('unauthorized, no-assignment, and assignment-service errors never render false empty sets', async ({ page }) => {
  const unauthorized = await install(page, {
    currentStatus: 403,
    currentBody: { error: 'This Department is not assigned to your account' },
  });
  await page.goto(`/FormView?slug=${SLUG}&department_id=${IDS.departmentA}&tenant=bnms-fixture`);
  await dismissCookie(page);
  await expect(page.getByTestId('department-current-set-error')).toContainText(/assigned|could not|forbidden/i);
  await expect(page.getByTestId(`repeatable-row-${WF}-0`)).toHaveCount(0);
  await expect(page.getByTestId(`repeatable-row-${EQ}-0`)).toHaveCount(0);
  expect(unauthorized.unexpectedWrites).toEqual([]);

  const noAssignmentPage = await page.context().newPage();
  const noAssignment = await install(noAssignmentPage, {
    optionsBody: { departments: [] },
  });
  await noAssignmentPage.goto(`/FormView?slug=${SLUG}&tenant=bnms-fixture`);
  await dismissCookie(noAssignmentPage);
  await expect(noAssignmentPage.getByTestId('department-current-set-no-options')).toContainText(/No Department is assigned/i);
  await expect(noAssignmentPage.getByTestId(`repeatable-row-${WF}-0`)).toHaveCount(0);
  await expect(noAssignmentPage.getByTestId(`repeatable-row-${EQ}-0`)).toHaveCount(0);
  expect(noAssignment.unexpectedWrites).toEqual([]);
  await noAssignmentPage.close();

  const serviceErrorPage = await page.context().newPage();
  const serviceError = await install(serviceErrorPage, {
    optionsStatus: 503,
    optionsBody: { error: 'Department assignment service unavailable' },
  });
  await serviceErrorPage.goto(`/FormView?slug=${SLUG}&tenant=bnms-fixture`);
  await dismissCookie(serviceErrorPage);
  await expect(serviceErrorPage.getByTestId('department-current-set-error')).toContainText(/unavailable|could not/i);
  await expect(serviceErrorPage.getByTestId(`repeatable-row-${WF}-0`)).toHaveCount(0);
  await expect(serviceErrorPage.getByTestId(`repeatable-row-${EQ}-0`)).toHaveCount(0);
  expect(serviceError.unexpectedWrites).toEqual([]);
  await serviceErrorPage.close();
});

test('real current-set hook confirmation clears scoped rows, retains unrelated values, and clears on identity changes', async ({ page }) => {
  const state = await install(page);
  await page.goto(`/FormView?slug=${SLUG}&tenant=bnms-fixture`);
  await dismissCookie(page);

  // Mount a deliberately tiny browser harness around the production hook and
  // notice. FormView/embed already exercise row rendering above; this harness
  // exposes the hook callback directly because the current picker is only
  // rendered before a Department is selected. It avoids changing shared app
  // files just to make a switch control testable.
  await page.evaluate(async () => {
    // In Vite dev mode dependencies are served from an /@fs URL (and carry a
    // version query), not from /node_modules. Reuse the URLs the running app
    // actually loaded so this remains valid with the current dev server.
    const servedDependency = (fileName) => {
      const entry = performance.getEntriesByType('resource')
        .map(resource => resource.name)
        .find(name => new URL(name).pathname.endsWith(`/deps/${fileName}`));
      if (!entry) throw new Error(`The running app did not load ${fileName}`);
      return entry;
    };
    const ReactModule = await import(servedDependency('react.js'));
    const ReactDOM = await import(servedDependency('react-dom_client.js'));
    const Query = await import(servedDependency('@tanstack_react-query.js'));
    const currentSet = await import('/src/lib/departmentCurrentSet.js');
    const noticeModule = await import('/src/components/forms/DepartmentCurrentSetNotice.jsx');
    const React = ReactModule.default;
    const { createRoot } = ReactDOM.default || ReactDOM;
    const { QueryClient, QueryClientProvider } = Query;
    const { useDepartmentCurrentSet, currentSetSaveBlocked } = currentSet;
    const { default: DepartmentCurrentSetNotice } = noticeModule;
    const A = 'cd1ebfd3-3e16-4091-be5a-99992d926f2f';
    const B = 'dd2ebfd3-3e16-4091-be5a-99992d926f2f';
    const WF_ID = 'field_1788530969408';
    const EQ_ID = 'field_1789479861104';
    const UNRELATED_ID = 'fixture-unrelated-answer';
    const form = {
      id: '8b6f44d3-83f8-449e-9496-b10b1dc28e5f',
      slug: 'bnms-current-set-picker-browser-fixture',
      current_set_enabled: true,
      current_set_configuration: {
        workforce_container_field_id: WF_ID,
        equipment_container_field_id: EQ_ID,
      },
    };
    function Harness() {
      const [departmentId, setDepartmentId] = React.useState(A);
      const [principalId, setPrincipalId] = React.useState('member-a');
      const [formValues, setFormValues] = React.useState({ [UNRELATED_ID]: 'keep me' });
      const current = useDepartmentCurrentSet({
        form,
        departmentId,
        principalId,
        formValues,
        setFormValues,
        ready: true,
        onDepartmentSelect: setDepartmentId,
      });
      const blocked = currentSetSaveBlocked({
        enabled: current.active,
        departmentId: current.departmentId,
        loading: current.loading,
        error: current.error,
        currentSet: current.currentSet,
        sectionIds: current.sectionIds,
        acknowledgements: current.acknowledgements,
        baselineReady: current.baselineReady,
      });
      return React.createElement('main', {},
        React.createElement(DepartmentCurrentSetNotice, { state: current, blockedReason: blocked }),
        React.createElement('output', { 'data-testid': 'hook-values' }, JSON.stringify(formValues)),
        React.createElement('button', {
          type: 'button',
          'data-testid': 'hook-edit-scoped',
          onClick: () => setFormValues(previous => ({
            ...previous,
            [WF_ID]: [{ _row_id: 'edited', row: 'old scoped answer' }],
          })),
        }, 'Edit scoped answer'),
        React.createElement('button', {
          type: 'button',
          'data-testid': 'hook-switch',
          onClick: () => current.selectDepartment(B),
        }, 'Switch Department'),
        React.createElement('button', {
          type: 'button',
          'data-testid': 'hook-principal-change',
          onClick: () => setPrincipalId('member-b'),
        }, 'Change principal'),
        React.createElement('button', {
          type: 'button',
          'data-testid': 'hook-logout',
          onClick: () => setPrincipalId(null),
        }, 'Log out'),
      );
    }
    const root = document.createElement('div');
    root.id = 'current-set-hook-harness';
    document.body.replaceChildren(root);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    createRoot(root).render(React.createElement(QueryClientProvider, { client: queryClient }, React.createElement(Harness)));
  });

  await expect(page.getByTestId('department-current-set-review')).toBeVisible();
  await page.getByTestId('hook-edit-scoped').click();
  await page.evaluate(() => { window.confirm = () => false; });
  await page.getByTestId('hook-switch').click();
  await expect(page.getByTestId('hook-values')).toContainText('old scoped answer');
  await page.evaluate(() => { window.confirm = () => true; });
  await page.getByTestId('hook-switch').click();
  await expect.poll(async () => page.getByTestId('hook-values').textContent()).not.toContain('old scoped answer');
  await expect(page.getByTestId('hook-values')).toContainText('keep me');
  await expect(page.getByTestId('department-current-set-review')).toContainText('Radiology — South');

  // A principal transition must discard a locally edited row before the new
  // principal's authoritative set is allowed to repopulate it.
  await page.getByTestId('hook-edit-scoped').click();
  await page.getByTestId('hook-principal-change').click();
  await expect.poll(async () => page.getByTestId('hook-values').textContent()).not.toContain('old scoped answer');
  await page.getByTestId('hook-logout').click();
  await expect.poll(async () => page.getByTestId('hook-values').textContent()).not.toContain('Radiology — South');
  await expect(page.getByTestId('hook-values')).toContainText('keep me');
  expect(state.unexpectedWrites).toEqual([]);
  expect(state.pageErrors).toEqual([]);
});