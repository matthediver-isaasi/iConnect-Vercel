import { test, expect } from '@playwright/test';

const viewer = { id: 'fixture-member', tenant_id: 'fixture-tenant', organization_id: 'fixture-org', role_id: 'fixture-role', email: 'fixture@example.invalid', first_name: 'Fixture', last_name: 'Admin', member_excluded_features: [] };
const metadata = { member: { core: [], custom: [] }, organization: { core: [], custom: [] }, event: { core: [], custom: [] }, custom_objects: [{
  id: 'fixture-department', label: 'Organisation department', relationships: [{
    id: 'fixture-members', label: 'Members', object_side: 'source',
    record_fields: [{ id: 'fixture-title', key: 'title', label: 'Title', data_type: 'text', operators: ['equals', 'contains', 'is_empty'] }],
    relationship_fields: [{ id: 'fixture-survey', key: 'survey_respondent', label: 'Survey respondent', data_type: 'boolean', operators: ['is_true', 'is_false', 'is_empty', 'is_not_empty'] }],
  }],
}] };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function fixtures(page, baseURL, fieldMetadata = metadata) {
  const origin = new URL(baseURL).origin;
  const state = { lists: [], saves: [], forbidden: [], definitionsFail: false, definitionsMissing: false, countError: false };
  await page.addInitScript(() => { URL.parse ??= (value, base) => { try { return new URL(value, base); } catch { return null; } }; localStorage.clear(); sessionStorage.clear(); });
  await page.context().routeWebSocket('**/*', socket => socket.close());
  await page.context().route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (url.origin !== origin) return route.fulfill({ status: 204, body: '' });
    if (path.startsWith('/api/')) {
      if (path === '/api/email-campaigns' && url.searchParams.has('summary')) return json(route, { totalSent: 0, totalOpened: 0, totalClicked: 0, openRate: 0, clickRate: 0 });
      if (path === '/api/audience-lists' && ['POST', 'PATCH'].includes(method)) {
        const body = request.postDataJSON();
        state.saves.push({ method, body });
        const list = { ...body, id: body.id || 'fixture-saved-list' };
        state.lists = [list];
        return json(route, list);
      }
      if (path === '/api/audience-lists/counts' && method === 'POST') return json(route, state.countError
        ? { success: true, counts: {}, errors: { 'fixture-saved-list': 'The saved Custom Object relationship is no longer active.' } }
        : { success: true, counts: { 'fixture-saved-list': 2 }, errors: {} });
      if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
        state.forbidden.push(`${method} ${path}`);
        return json(route, { error: 'Unexpected fixture write blocked' }, 599);
      }
      if (path === '/api/audience-lists/filterable-fields') return state.definitionsFail ? json(route, { error: 'Fixture discovery failure' }, 503) : json(route, state.definitionsMissing ? { ...fieldMetadata, custom_objects: [], organization_group: { core: [], custom: [] } } : fieldMetadata);
      if (path === '/api/audience-lists') return json(route, url.searchParams.has('page') ? { lists: state.lists, total: state.lists.length } : state.lists);
      if (path === '/api/auth/me') return json(route, viewer);
      if (path === '/api/auth/tenant-user-me') return json(route, { authenticated: true, user: viewer, tenant: { id: viewer.tenant_id, slug: 'fixture' }, tenantId: viewer.tenant_id, memberId: viewer.id });
      if (path === `/api/entities/Member/${viewer.id}`) return json(route, viewer);
      if (path === `/api/entities/Role/${viewer.role_id}`) return json(route, { id: viewer.role_id, name: 'Administrator', excluded_features: [] });
      if (path === '/api/entities/Role') return json(route, [{ id: viewer.role_id, name: 'Administrator', excluded_features: [] }]);
      if (path === '/api/entities/Organization') return json(route, [{ id: viewer.organization_id, name: 'Fixture Organisation' }]);
      if (path === '/api/zoho-campaigns/oauth') return json(route, { connected: false, credentialsConfigured: false });
      if (path === '/api/communication/inbox/unread-count') return json(route, { count: 0 });
      if (path === '/api/admin/form-submissions/stats') return json(route, { total: 0, pending: 0 });
      if (path.startsWith('/api/public/')) return json(route, {});
      // Empty shell datasets only: no API request is ever forwarded.
      return json(route, []);
    }
    if (method === 'GET' && (path === '/CommunicationsManagement' || ['/src/', '/@', '/node_modules/', '/assets/'].some(prefix => path.startsWith(prefix)) || path === '/favicon.ico' || path === '/dougal-avatar.webp')) return route.continue();
    state.forbidden.push(`${method} ${path}`);
    return route.fulfill({ status: 599, body: 'Unexpected request blocked' });
  });
  return state;
}

for (const type of ['list', 'country', 'countries']) {
  test(`Optionless Organisation Group ${type} accepts values and survives save/reopen`, async ({ page, baseURL }) => {
    const state = await fixtures(page, baseURL, { ...metadata, organization_group: { core: [], custom: [
      { key: 'optionless', label: 'Group locations', field_type: 'custom', data_type: type },
    ] } });
    const choose = async (testId, option) => {
      await page.getByTestId(testId).click();
      await page.getByRole('option', { name: option, exact: true }).click();
    };
    await page.goto('/CommunicationsManagement');
    await page.getByTestId('tab-lists').click();
    await page.getByTestId('button-create-list').click();
    await page.getByTestId('input-edit-list-name').fill('Optionless group audience');
    await page.getByTestId('button-add-list-segment').click();
    await choose('select-add-list-segment-type', 'Field Filter');
    await choose('select-filter-scope-0-0', 'Organisation Group');
    await choose('select-filter-field-0-0', 'Group locations');
    await choose('select-filter-operator-0-0', 'Contains any of');
    await page.getByRole('textbox', { name: 'Condition values', exact: true }).fill('United Kingdom\nKorea, Republic of');
    await page.getByTestId('button-confirm-add-list-segment').click();
    await page.getByTestId('button-save-edit-list').click();
    await expect.poll(() => state.saves.length).toBe(1);
    expect(state.saves[0].body.target_audiences[0].filter_groups[0].conditions[0]).toMatchObject({
      entity_scope: 'organization_group', data_type: type, operator: 'contains', value: ['United Kingdom', 'Korea, Republic of'],
    });
    await page.goto('/CommunicationsManagement');
    await page.getByTestId('tab-lists').click();
    await page.getByTestId('button-edit-list-fixture-saved-list').click();
    await page.getByRole('button', { name: 'Edit filters', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Condition values', exact: true })).toHaveValue('United Kingdom\nKorea, Republic of');
    await page.getByTestId('button-confirm-add-list-segment').click();
    await page.getByTestId('button-save-edit-list').click();
    await expect.poll(() => state.saves.length).toBe(2);
    expect(state.saves[1].body.target_audiences).toEqual(state.saves[0].body.target_audiences);
    expect(state.forbidden).toEqual([]);
  });
}

test('Organisation Group dropdown saves, reopens and rejects unavailable definitions', async ({ page, baseURL }) => {
  const state = await fixtures(page, baseURL, { ...metadata, organization_group: { core: [], custom: [
    { key: 'group-type', label: 'Group type', field_type: 'custom', data_type: 'dropdown', options: [
      { value: 'trust', label: 'NHS Trust/Health Board' }, { value: 'university', label: 'University' },
    ] },
  ] } });
  const choose = async (testId, option) => {
    await page.getByTestId(testId).click();
    await page.getByRole('option', { name: option, exact: true }).click();
  };
  await page.goto('/CommunicationsManagement');
  await page.getByTestId('tab-lists').click();
  await page.getByTestId('button-create-list').click();
  await page.getByTestId('input-edit-list-name').fill('Group dropdown audience');
  await page.getByTestId('button-add-list-segment').click();
  await choose('select-add-list-segment-type', 'Field Filter');
  await choose('select-filter-scope-0-0', 'Organisation Group');
  await choose('select-filter-field-0-0', 'Group type');
  await choose('select-filter-operator-0-0', 'Equals');
  await page.getByRole('combobox', { name: 'Condition value', exact: true }).selectOption('trust');
  await page.getByTestId('button-confirm-add-list-segment').click();
  await expect(page.getByTestId('edit-list-segment-0')).toContainText('Organisation Group.Group type = NHS Trust/Health Board');
  await page.getByTestId('button-save-edit-list').click();
  await expect.poll(() => state.saves.length).toBe(1);
  expect(state.saves[0].body.target_audiences[0].filter_groups[0].conditions[0]).toMatchObject({
    entity_scope: 'organization_group', field_key: 'group-type', field_type: 'custom',
    data_type: 'dropdown', operator: 'equals', value: 'trust',
  });
  const reopen = async () => {
    await page.goto('/CommunicationsManagement');
    await page.getByTestId('tab-lists').click();
    await page.getByTestId('button-edit-list-fixture-saved-list').click();
    await page.getByRole('button', { name: 'Edit filters', exact: true }).click();
  };
  await reopen();
  await expect(page.getByRole('combobox', { name: 'Condition value', exact: true })).toHaveValue('trust');
  await choose('select-filter-operator-0-0', 'Is one of');
  await page.getByLabel('University', { exact: true }).check();
  await page.getByTestId('button-confirm-add-list-segment').click();
  await page.getByTestId('button-save-edit-list').click();
  await expect.poll(() => state.saves.length).toBe(2);
  await reopen();
  await expect(page.getByLabel('University', { exact: true })).toBeChecked();
  state.definitionsMissing = true;
  await reopen();
  await expect(page.getByText('Organisation Group field is unavailable. Reselect an active field.', { exact: true })).toBeVisible();
  await page.getByTestId('button-confirm-add-list-segment').click();
  expect(state.saves).toHaveLength(2);
  expect(state.forbidden).toEqual([]);
});

test('full page isolated create/save/reopen, discovery retry and stale references', async ({ page, baseURL }) => {
  const state = await fixtures(page, baseURL);
  const choose = async (label, option) => {
    await page.getByRole('combobox', { name: label, exact: true }).click();
    await page.getByRole('option', { name: option, exact: true }).click();
  };
  const openList = async () => {
    await page.goto('/CommunicationsManagement');
    await page.getByTestId('tab-lists').click();
    await page.getByTestId('button-edit-list-fixture-saved-list').click();
    await page.getByRole('button', { name: 'Edit filters', exact: true }).click();
  };
  try {
    await page.goto('/CommunicationsManagement');
    await page.getByTestId('tab-lists').click();
    await page.getByTestId('button-create-list').click();
    await page.getByTestId('input-edit-list-name').fill('Isolated responder audience');
    await page.getByTestId('button-add-list-segment').click();
    await page.getByTestId('select-add-list-segment-type').click();
    await page.getByRole('option', { name: 'Field Filter', exact: true }).click();
    await page.getByTestId('select-filter-scope-0-0').click();
    await page.getByRole('option', { name: 'Custom Object', exact: true }).click();
    await choose('Custom Object', 'Organisation department');
    await choose('Member relationship', 'Members (Object → Member)');
    await choose('Record or relationship field', 'Relationship: Survey respondent');
    await choose('Operator', 'Yes');
    await page.getByTestId('button-confirm-add-list-segment').click();
    await expect(page.getByTestId('edit-list-segment-0')).toContainText('Organisation department → Members → Relationship: Survey respondent is Yes');
    await page.getByTestId('button-save-edit-list').click();
    await expect.poll(() => state.saves.length).toBe(1);
    const saved = state.saves[0].body;
    expect(state.saves[0].method).toBe('POST');
    expect(saved.target_audiences[0].filter_groups[0].conditions[0]).toMatchObject({
      entity_scope: 'custom_object', version: 1, custom_object_id: 'fixture-department',
      relationship_definition_id: 'fixture-members', object_side: 'source',
      field_type: 'relationship', field_key: 'survey_respondent', field_id: 'fixture-survey',
      data_type: 'boolean', operator: 'is_true',
    });
    await openList();
    await expect(page.getByRole('combobox', { name: 'Custom Object', exact: true })).toContainText('Organisation department');
    await expect(page.getByRole('combobox', { name: 'Record or relationship field', exact: true })).toContainText('Relationship: Survey respondent');
    await expect(page.getByRole('combobox', { name: 'Operator', exact: true })).toContainText('Yes');
    await page.getByTestId('button-confirm-add-list-segment').scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'screenshots/custom-object-audience-reopened-fixture.png', fullPage: false });
    await choose('Operator', 'No');
    await page.getByTestId('button-confirm-add-list-segment').click();
    await page.getByTestId('button-save-edit-list').click();
    await expect.poll(() => state.saves.length).toBe(2);
    expect(state.saves[1].method).toBe('PATCH');
    expect(state.saves[1].body.target_audiences[0].filter_groups[0].conditions[0].operator).toBe('is_false');

    state.definitionsFail = true;
    await openList();
    await expect(page.getByText('Unable to load field definitions.', { exact: false })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('combobox', { name: 'Record or relationship field', exact: true })).toContainText('Survey respondent');
    await expect(page.getByTestId('button-confirm-add-list-segment')).toBeDisabled();
    state.definitionsFail = false;
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(page.getByTestId('button-confirm-add-list-segment')).toBeEnabled();
    await expect(page.getByRole('combobox', { name: 'Operator', exact: true })).toContainText('No');

    state.definitionsMissing = true;
    await openList();
    await expect(page.getByTestId('button-confirm-add-list-segment')).toBeDisabled();
    await expect(page.getByRole('combobox', { name: 'Custom Object', exact: true })).toContainText('Organisation department');
    await expect(page.getByText('Select an available Custom Object. The saved object may be archived or inaccessible.').first()).toBeVisible();
    await page.screenshot({ path: 'screenshots/custom-object-audience-stale-fixture.png', fullPage: false });
    await page.getByTestId('button-save-edit-list').click();
    await expect(page.getByText('Apply or cancel your field filter edits before saving the list.', { exact: true })).toBeVisible();
    await page.getByText('Edit Field Filter', { exact: true }).locator('..').getByRole('button').click();
    await page.getByTestId('button-save-edit-list').click();
    await expect(page.getByTestId('button-save-edit-list')).toBeVisible();
    expect(state.saves).toHaveLength(2);
    state.countError = true;
    await page.goto('/CommunicationsManagement');
    await page.getByTestId('tab-lists').click();
    await expect(page.getByTestId('list-count-error-fixture-saved-list')).toContainText('The saved Custom Object relationship is no longer active.');
    await expect(page.getByTestId('card-list-fixture-saved-list')).not.toContainText('0 recipients');
    state.countError = false;
    await page.getByRole('button', { name: 'Retry count', exact: true }).click();
    await expect(page.getByTestId('list-count-error-fixture-saved-list')).toHaveCount(0);
    await expect(page.getByTestId('card-list-fixture-saved-list')).toContainText('2 recipients');
  } finally {
    expect(state.forbidden, 'All unexpected requests/writes blocked').toEqual([]);
  }
});