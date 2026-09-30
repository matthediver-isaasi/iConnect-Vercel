import { test, expect } from '@playwright/test';

const GROUP_A = 'expiry-group-alpha';
const GROUP_B = 'expiry-group-beta';
const CLASS_A = 'expiry-class-committee';
const CLASS_B = 'expiry-class-network';

const classifications = [
  { id: CLASS_A, name: 'Committees', is_active: true },
  { id: CLASS_B, name: 'Networks', is_active: true },
];

const primaryGroups = [
  {
    id: GROUP_A,
    name: 'Alpha Mixed Committee',
    description: 'Current and historic appointments',
    roles: ['Chair', 'Secretary', 'Advisor', 'Member'],
    leadership_roles: ['Chair'],
    classification_id: CLASS_A,
    is_active: true,
  },
  {
    id: GROUP_B,
    name: 'Beta Historic Network',
    description: 'Historic appointments only',
    roles: ['Convenor', 'Guest'],
    classification_id: CLASS_B,
    is_active: true,
  },
];

const fillerGroups = Array.from({ length: 12 }, (_, index) => ({
  id: `expiry-filler-${String(index + 1).padStart(2, '0')}`,
  name: `Fixture Group ${String(index + 1).padStart(2, '0')}`,
  description: 'Pagination fixture',
  roles: ['Member'],
  classification_id: index % 2 ? CLASS_A : CLASS_B,
  is_active: true,
}));

const members = [
  ['alice', 'Alice', 'Active'],
  ['provisioned', 'Priya', 'Provisioned'],
  ['dana', 'Dana', 'Current'],
  ['evan', 'Evan', 'Current'],
  ['frank', 'Frank', 'Expired'],
  ['grace', 'Grace', 'Expired'],
  ['hank', 'Hank', 'Historic'],
].map(([id, first_name, last_name]) => ({
  id: `expiry-member-${id}`,
  first_name,
  last_name,
  email: `${id}@example.invalid`,
}));

const guests = [
  {
    id: 'expiry-guest-gabrielle',
    first_name: 'Gabrielle',
    last_name: 'Guest',
    email: 'gabrielle@example.invalid',
  },
  {
    id: 'expiry-guest-provisioned',
    member_id: 'expiry-member-provisioned',
    first_name: 'Priya',
    last_name: 'Provisioned',
    email: 'priya@example.invalid',
  },
  {
    id: 'expiry-guest-iris',
    first_name: 'Iris',
    last_name: 'Historic Guest',
    email: 'iris@example.invalid',
  },
];

const seedAssignments = [
  // Expired rows are deliberately newest, proving that filtering happens
  // before both the five-row preview and the full modal are rendered.
  { id: 'assignment-frank', group_id: GROUP_A, member_id: 'expiry-member-frank', group_role: 'Chair', expires_at: '2001-01-01', created_at: '2026-07-07T12:00:00Z', is_group_admin: false },
  { id: 'assignment-grace', group_id: GROUP_A, member_id: 'expiry-member-grace', group_role: 'Secretary', expires_at: '2002-02-02', created_at: '2026-07-06T12:00:00Z', is_group_admin: false },
  { id: 'assignment-alice', group_id: GROUP_A, member_id: 'expiry-member-alice', group_role: 'Chair', expires_at: '2999-01-01', created_at: '2026-07-05T12:00:00Z', is_group_admin: true },
  // Alice has a second current role: six visible rows still represent five people.
  { id: 'assignment-alice-secretary', group_id: GROUP_A, member_id: 'expiry-member-alice', group_role: 'Secretary', created_at: '2026-07-04T18:00:00Z', is_group_admin: false },
  { id: 'assignment-gabrielle', group_id: GROUP_A, guest_id: 'expiry-guest-gabrielle', group_role: 'Advisor', created_at: '2026-07-04T12:00:00Z', is_group_admin: false },
  { id: 'assignment-priya', group_id: GROUP_A, member_id: 'expiry-member-provisioned', group_role: 'Advisor', created_at: '2026-07-03T12:00:00Z', is_group_admin: false },
  { id: 'assignment-dana', group_id: GROUP_A, member_id: 'expiry-member-dana', group_role: 'Member', created_at: '2026-07-02T12:00:00Z', is_group_admin: false },
  { id: 'assignment-evan', group_id: GROUP_A, member_id: 'expiry-member-evan', group_role: 'Member', created_at: '2026-07-01T12:00:00Z', is_group_admin: false },
  { id: 'assignment-hank', group_id: GROUP_B, member_id: 'expiry-member-hank', group_role: 'Convenor', expires_at: '2003-03-03', created_at: '2026-06-02T12:00:00Z', is_group_admin: false },
  { id: 'assignment-iris', group_id: GROUP_B, guest_id: 'expiry-guest-iris', group_role: 'Guest', expires_at: '2004-04-04', created_at: '2026-06-01T12:00:00Z', is_group_admin: false },
];

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    headers: { 'Cache-Control': 'private, no-store' },
    body: JSON.stringify(body),
  });
}

async function installIsolatedApis(page) {
  const state = {
    assignments: seedAssignments.map((assignment) => ({ ...assignment })),
    assignmentReads: 0,
    writes: [],
    unexpected: [],
  };

  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const { pathname } = url;
    const method = request.method();
    // The broad glob also sees Vite /@fs/.../src/api/*.js module requests.
    if (!pathname.startsWith('/api/')) return route.continue();

    if (pathname === '/api/public/system-settings' && method === 'GET') return json(route, []);
    if (pathname === '/api/entities/MemberGroup' && method === 'GET') {
      return json(route, [...primaryGroups, ...fillerGroups]);
    }
    if (pathname === '/api/entities/Member' && method === 'GET') return json(route, members);
    if (pathname === '/api/entities/MemberGroupGuest' && method === 'GET') return json(route, guests);
    if (pathname === '/api/entities/MemberGroupClassification' && method === 'GET') {
      return json(route, classifications);
    }
    if (pathname === '/api/entities/EmailTemplate' && method === 'GET') return json(route, []);
    if (pathname === '/api/entities/MemberGroupAssignment' && method === 'GET') {
      state.assignmentReads += 1;
      return json(route, state.assignments);
    }

    const assignmentMatch = pathname.match(/^\/api\/entities\/MemberGroupAssignment\/([^/]+)$/);
    if (assignmentMatch && method === 'PATCH') {
      const id = decodeURIComponent(assignmentMatch[1]);
      const payload = request.postDataJSON();
      state.writes.push({ method, id, payload });
      const index = state.assignments.findIndex(assignment => assignment.id === id);
      if (index < 0) return json(route, { error: 'Fixture assignment not found' }, 404);
      state.assignments[index] = { ...state.assignments[index], ...payload };
      return json(route, state.assignments[index]);
    }
    if (assignmentMatch && method === 'DELETE') {
      const id = decodeURIComponent(assignmentMatch[1]);
      state.writes.push({ method, id });
      state.assignments = state.assignments.filter(assignment => assignment.id !== id);
      return json(route, { success: true });
    }

    state.unexpected.push(`${method} ${pathname}${url.search}`);
    return json(route, []);
  });

  return state;
}

async function mountManagementPage(page) {
  page.on('pageerror', error => console.error(`browser page error: ${error.message}`));
  page.on('console', message => {
    if (message.type() === 'error') console.error(`browser console error: ${message.text()}`);
  });
  page.on('requestfailed', request => console.error(`browser request failed: ${request.url()} ${request.failure()?.errorText}`));
  await page.route('**/__group-members-expiry-test', route => route.fulfill({
    contentType: 'text/html',
    body: `<html><head><meta charset="utf-8"></head><body><div id="root"></div>
      <script type="module">
        import RefreshRuntime from '/@react-refresh';
        RefreshRuntime.injectIntoGlobalHook(window);
        window.$RefreshReg$ = () => {};
        window.$RefreshSig$ = () => (type) => type;
        window.__vite_plugin_react_preamble_installed__ = true;
      </script>
      <script type="module">
        import React from '/@fs${process.cwd()}/node_modules/.vite/deps/react.js';
        import ReactDOM from '/@fs${process.cwd()}/node_modules/.vite/deps/react-dom_client.js';
        import LayoutContext from '/src/contexts/LayoutContext.jsx';
        import MemberGroupManagement from '/src/pages/MemberGroupManagement.jsx';
        import '/src/index.css';
        const servedQuery = performance.getEntriesByType('resource')
          .map(resource => resource.name)
          .find(name => new URL(name).pathname.endsWith('/deps/@tanstack_react-query.js'));
        if (!servedQuery) throw new Error('The production page did not load React Query');
        const { QueryClient, QueryClientProvider } = await import(servedQuery);
        const h = React.createElement;
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
        const layout = {
          authResolved: true,
          sessionValidated: false,
          memberInfo: null,
          organizationInfo: null,
          setMemberInfo: () => {},
          setOrganizationInfo: () => {},
          retrySessionRole: () => {},
        };
        ReactDOM.createRoot(document.getElementById('root')).render(
          h(QueryClientProvider, { client: queryClient },
            h(LayoutContext.Provider, { value: layout }, h(MemberGroupManagement)))
        );
      </script></body></html>`,
  }));

  await page.goto('/__group-members-expiry-test');
  await expect(page.getByRole('heading', { name: 'Member Groups' })).toBeVisible();
  await expect(page.getByTestId(`switch-show-expired-members-${GROUP_A}`)).toBeVisible();
}

function cardFor(page, groupId) {
  return page.getByTestId(`switch-show-expired-members-${groupId}`)
    .locator("xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' rounded-xl ')][1]");
}

test('per-card expired filters drive counts, previews, modal search, and assignment refresh', async ({ page }) => {
  const state = await installIsolatedApis(page);
  await mountManagementPage(page);

  const alphaSwitch = page.getByTestId(`switch-show-expired-members-${GROUP_A}`);
  const betaSwitch = page.getByTestId(`switch-show-expired-members-${GROUP_B}`);
  const alphaCard = cardFor(page, GROUP_A);
  const betaCard = cardFor(page, GROUP_B);

  await page.screenshot({
    path: 'test-results/group-members-dialog/management-expiry-fixture.png',
    fullPage: true,
  });
  await expect(alphaSwitch).toBeChecked();
  await expect(betaSwitch).toBeChecked();
  await expect(alphaCard).toContainText('Members: 7');
  await expect(betaCard).toContainText('Members: 2');
  await expect(alphaCard).toContainText('Frank Expired');
  await expect(alphaCard).toContainText('Grace Expired');
  await expect(alphaCard.getByTestId(`button-view-all-members-${GROUP_A}`)).toHaveText('View all (7)');

  await alphaCard.getByTestId(`button-view-all-members-${GROUP_A}`).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading')).toHaveText('Members — Alpha Mixed Committee');
  await expect(dialog.getByRole('status')).toHaveText('7 people');
  await dialog.getByLabel('Search by name').fill('gabrielle');
  await expect(dialog.getByRole('status')).toHaveText('1 of 7 people match');
  await expect(dialog).toContainText('Gabrielle Guest');
  await expect(dialog.getByText('Guest', { exact: true })).toBeVisible();
  await dialog.getByLabel('Search by name').fill('frank');
  await expect(dialog).toContainText('Frank Expired');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  // The switches are independent: hiding Alpha's history must not alter Beta.
  await alphaSwitch.click();
  await expect(alphaSwitch).not.toBeChecked();
  await expect(betaSwitch).toBeChecked();
  await expect(alphaCard).toContainText('Members: 5');
  await expect(alphaCard).not.toContainText('Frank Expired');
  await expect(alphaCard).not.toContainText('Grace Expired');
  await expect(alphaCard).toContainText('Dana Current');
  await expect(alphaCard.getByTestId(`button-view-all-members-${GROUP_A}`)).toHaveText('View all (5)');
  await expect(betaCard).toContainText('Members: 2');

  // Six current rows (Alice has two roles) keep the filtered modal available,
  // while its count remains the unique five-person count.
  await alphaCard.getByTestId(`button-view-all-members-${GROUP_A}`).click();
  const filteredDialog = page.getByRole('dialog').filter({
    has: page.getByRole('heading', { name: 'Members — Alpha Mixed Committee' }),
  });
  await expect(filteredDialog.getByRole('status')).toHaveText('5 people');
  await expect(filteredDialog).not.toContainText('Frank Expired');
  await expect(filteredDialog).not.toContainText('Grace Expired');
  await filteredDialog.getByLabel('Search by name').fill('alice');
  await expect(filteredDialog.getByRole('status')).toHaveText('1 of 5 people match');
  await expect(filteredDialog.getByTestId('list-all-members').locator(':scope > div')).toHaveCount(2);
  await expect(filteredDialog).toContainText('Chair');
  await expect(filteredDialog).toContainText('Secretary');
  await filteredDialog.getByRole('button', { name: 'Clear', exact: true }).click();
  await filteredDialog.getByLabel('Search by name').fill('frank');
  await expect(filteredDialog.getByRole('status')).toHaveText('0 of 5 people match');
  await expect(filteredDialog).toContainText('No members or guests match your search.');
  await filteredDialog.getByRole('button', { name: 'Clear', exact: true }).click();

  // Editing expiry while the members modal remains open refreshes both modal
  // and card from the invalidated assignment query.
  const readsBeforeEdit = state.assignmentReads;
  await filteredDialog.getByTestId('button-edit-assignment-assignment-dana').click();
  await page.getByTestId('input-edit-assignment-expiry').fill('2000-05-06');
  await page.getByTestId('button-save-assignment').click();
  await expect.poll(() => state.assignmentReads).toBeGreaterThan(readsBeforeEdit);
  await expect.poll(() => state.writes.find(write => write.id === 'assignment-dana')?.payload)
    .toMatchObject({ expires_at: '2000-05-06' });
  await expect(filteredDialog).toBeVisible();
  await expect(filteredDialog.getByRole('status')).toHaveText('4 people');
  await expect(filteredDialog).not.toContainText('Dana Current');
  await expect(alphaCard).toContainText('Members: 4');

  // Existing compact-row remove action also refreshes the still-open modal.
  const readsBeforeRemove = state.assignmentReads;
  await filteredDialog.getByRole('button', { name: 'Remove Evan Current (Member)' }).click();
  await expect.poll(() => state.writes.some(write =>
    write.method === 'DELETE' && write.id === 'assignment-evan')).toBe(true);
  await expect.poll(() => state.assignmentReads).toBeGreaterThan(readsBeforeRemove);
  await expect(filteredDialog.getByRole('status')).toHaveText('3 people');
  await expect(filteredDialog).not.toContainText('Evan Current');
  await expect(alphaCard).toContainText('Members: 3');
  await page.keyboard.press('Escape');
  await expect(filteredDialog).toHaveCount(0);

  await betaSwitch.click();
  await expect(betaSwitch).not.toBeChecked();
  await expect(betaCard).toContainText('Members: 0');
  await expect(betaCard).toContainText('All assignments are expired. Turn on Show expired members to view them.');
  await expect(betaCard).not.toContainText('Hank Historic');
  await expect(betaCard).not.toContainText('Iris Historic Guest');
  await expect(alphaSwitch).not.toBeChecked();

  // Restoring history brings the newly-expired edit back everywhere, while a
  // removed row stays removed. Reopening also starts a clean search session.
  await alphaSwitch.click();
  await expect(alphaCard).toContainText('Members: 6');
  await expect(alphaCard).toContainText('Frank Expired');
  await expect(alphaCard).not.toContainText('Evan Current');
  await alphaCard.getByTestId(`button-view-all-members-${GROUP_A}`).click();
  await expect(dialog.getByLabel('Search by name')).toHaveValue('');
  await expect(dialog).toContainText('Dana Current');
  await dialog.getByLabel('Search by name').fill('priya');
  await expect(dialog).toContainText('Priya Provisioned');
  await expect(dialog.getByText('Guest', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await alphaCard.getByTestId(`button-view-all-members-${GROUP_A}`).click();
  await expect(dialog.getByLabel('Search by name')).toHaveValue('');
  await page.keyboard.press('Escape');

  // Existing admin action remains usable with history hidden.
  await alphaSwitch.click();
  await page.getByTestId('switch-group-admin-assignment-priya').click();
  await expect.poll(() => state.writes.find(write => write.id === 'assignment-priya')?.payload)
    .toMatchObject({ is_group_admin: true });
  await expect(state.unexpected).toEqual([]);
});

test('classification, sorting, and pagination preserve each group filter choice', async ({ page }) => {
  await installIsolatedApis(page);
  await mountManagementPage(page);

  const alphaSwitch = page.getByTestId(`switch-show-expired-members-${GROUP_A}`);
  await alphaSwitch.click();
  await expect(alphaSwitch).not.toBeChecked();

  // Name-desc moves Alpha and Beta onto page two of this 14-group fixture.
  const sort = page.getByRole('combobox').nth(1);
  await sort.click();
  await page.getByRole('option', { name: 'Name (Z-A)' }).click();
  await expect(alphaSwitch).toHaveCount(0);
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByTestId(`switch-show-expired-members-${GROUP_A}`)).not.toBeChecked();

  // Filtering unmounts and remounts cards; the group-keyed preference survives.
  const classification = page.getByTestId('select-classification-filter');
  await classification.click();
  await page.getByRole('option', { name: 'Networks', exact: true }).click();
  await expect(page.getByTestId(`switch-show-expired-members-${GROUP_A}`)).toHaveCount(0);
  await classification.click();
  await page.getByRole('option', { name: 'Committees', exact: true }).click();
  await expect(page.getByTestId(`switch-show-expired-members-${GROUP_A}`)).not.toBeChecked();

  await page.getByTestId('switch-group-by-classification').click();
  await expect(page.getByTestId(`section-classification-${CLASS_A}`)).toBeVisible();
  await expect(page.getByTestId(`switch-show-expired-members-${GROUP_A}`)).not.toBeChecked();
  await expect(cardFor(page, GROUP_A)).toContainText('Members: 5');
});