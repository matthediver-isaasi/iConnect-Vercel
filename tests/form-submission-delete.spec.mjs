import { test, expect } from '@playwright/test';

const id = 'synthetic-submission-delete';
const detail = `/FormSubmission/${id}`;
const form = { id: 'synthetic-form', name: 'Synthetic application', is_active: true, form_type: 'standard', fields: [] };
const submission = {
  id, form_id: form.id, form_name: form.name, status: 'new',
  submitted_by_name: 'Synthetic Applicant', created_date: '2026-10-01T12:00:00Z', submission_data: {},
};

// Deny all external traffic and locally intercept every API request, including
// unexpected writes. Only this synthetic ID can receive an acknowledged DELETE.
async function fixture(page, options = {}) {
  const state = { deletes: 0, detailReads: 0, deleted: false, unexpected: [], formMode: options.formMode };
  const member = { id: 'fixture-admin', tenant_id: 'fixture', role_id: 'fixture-role', email: 'admin@example.invalid', member_excluded_features: options.memberExcluded || [], is_team_member: false };
  const role = { id: member.role_id, name: options.roleExcluded ? 'Portal member' : 'Administrator', excluded_features: options.roleExcluded || [] };
  await page.context().route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== new URL(test.info().project.use.baseURL).origin) return route.abort();
    const path = url.pathname;
    if (!path.startsWith('/api/')) return route.continue();
    const json = body => route.fulfill({ json: body });
    if (path === `/api/entities/FormSubmission/${id}` && request.method() === 'DELETE') {
      state.deletes++;
      if (options.waitForDelete) await options.waitForDelete;
      if (options.failFirst && state.deletes === 1) {
        return route.fulfill({ status: 403, json: { error: 'Synthetic permission denied' } });
      }
      state.deleted = true;
      return json({ success: true });
    }
    if (path === `/api/entities/Member/${member.id}` && request.method() === 'PATCH') {
      const body = request.postDataJSON();
      if (Object.keys(body).length === 1 && typeof body.last_activity === 'string') return json(member);
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
      state.unexpected.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 599, json: { error: 'Fixture forbids this mutation' } });
    }
    if (path === '/api/auth/me') return json(member);
    if (path === '/api/auth/tenant-user-me') return json({ user: member, tenant: { id: member.tenant_id } });
    if (path === '/api/entities/Member') return json([member]);
    if (path === `/api/entities/Member/${member.id}`) return json(member);
    if (path === '/api/entities/Role') return json([role]);
    if (path === `/api/entities/Role/${role.id}`) return json(role);
    if (path === '/api/entities/Form') return json([{ ...form, ...options.form }]);
    if (path === `/api/entities/Form/${form.id}`) {
      if (options.waitForForm) await options.waitForForm;
      if (state.formMode === 'failed') return route.fulfill({ status: 503, json: { error: 'Synthetic metadata failure' } });
      if (state.formMode === 'missing') return json(null);
      return json({ ...form, ...options.form });
    }
    if (path === '/api/entities/FormSubmission') {
      if (state.deleted && options.waitForListAfterDelete) await options.waitForListAfterDelete;
      return json(state.deleted ? [] : [{ ...submission, ...options.submission }]);
    }
    if (path === `/api/entities/FormSubmission/${id}`) {
      state.detailReads++;
      if (state.deleted) return route.fulfill({ status: 404, json: { error: 'Deleted synthetic submission' } });
      return json({ ...submission, ...options.submission });
    }
    return json([]);
  });
  return state;
}

async function openDelete(page, query = '') {
  await page.goto(detail + query);
  await page.getByTestId('button-delete-submission').click();
  return page.getByRole('alertdialog', { name: 'Delete submission?' });
}

test('confirmation identifies the submission; cancel and Escape make no changes', async ({ page }) => {
  const state = await fixture(page);
  const dialog = await openDelete(page);
  await expect(dialog).toContainText(form.name);
  await expect(dialog).toContainText(submission.submitted_by_name);
  await expect(dialog).toContainText(id);
  await expect(dialog).toContainText('cannot be undone');
  await page.screenshot({ path: test.info().outputPath('desktop-confirmation.png') });
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByTestId('button-delete-submission').click();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  expect(state.deletes).toBe(0);
  expect(state.unexpected).toEqual([]);
});

test('one request under repeated clicks; wait for confirmation then preserve encoded filters', async ({ page }) => {
  let release;
  const waitForDelete = new Promise(resolve => { release = resolve; });
  const state = await fixture(page, { waitForDelete });
  const back = '/FormSubmissions?status=new&q=hello%20%26%20goodbye&size=50';
  const dialog = await openDelete(page, `?back=${encodeURIComponent(back)}`);
  const readsBefore = state.detailReads;
  await dialog.getByRole('button', { name: 'Delete submission', exact: true }).evaluate(button => {
    button.click(); button.click(); button.click();
  });
  await expect.poll(() => state.deletes).toBe(1);
  await expect(dialog.getByRole('button', { name: 'Deleting…' })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(page.getByText('Submission deleted', { exact: true })).not.toBeVisible();
  expect(new URL(page.url()).pathname).toBe(detail);
  release();
  await expect(page).toHaveURL(/\/FormSubmissions\?/);
  const result = new URL(page.url());
  expect(result.searchParams.get('status')).toBe('new');
  expect(result.searchParams.get('q')).toBe('hello & goodbye');
  expect(result.searchParams.get('size')).toBe('50');
  await expect(page.getByText('Submission deleted', { exact: true })).toBeVisible();
  expect(state.detailReads).toBe(readsBefore);
  expect(state.deletes).toBe(1);
  expect(state.unexpected).toEqual([]);
});

for (const [name, query, destination] of [
  ['default', '', '/FormSubmissions'],
  ['external URL', '?back=https%3A%2F%2Fexample.invalid', '/FormSubmissions'],
  ['protocol relative', '?back=%2F%2Fexample.invalid', '/FormSubmissions'],
  ['backslash authority', '?back=%2F%5Cexample.invalid', '/FormSubmissions'],
  ['organisation', '?from=org&orgId=synthetic-org', '/organisations/synthetic-org'],
  ['unsafe back with organisation', '?from=org&orgId=synthetic-org&back=%2F%2Fexample.invalid', '/organisations/synthetic-org'],
]) {
  test(`success returns safely: ${name}`, async ({ page }) => {
    const state = await fixture(page);
    const dialog = await openDelete(page, query);
    await dialog.getByRole('button', { name: 'Delete submission', exact: true }).click();
    await expect.poll(() => new URL(page.url()).pathname).toBe(destination);
    expect(state.deletes).toBe(1);
    expect(state.unexpected).toEqual([]);
  });
}

test('failed deletion remains on detail with useful error and retry', async ({ page }) => {
  const state = await fixture(page, { failFirst: true });
  const dialog = await openDelete(page);
  await dialog.getByRole('button', { name: 'Delete submission', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Synthetic permission denied');
  await expect(page.getByText('Submission deleted', { exact: true })).not.toBeVisible();
  expect(new URL(page.url()).pathname).toBe(detail);
  await dialog.getByRole('button', { name: 'Retry deletion' }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/FormSubmissions');
  expect(state.deletes).toBe(2);
  expect(state.unexpected).toEqual([]);
});

test('return to a previously cached list removes the row before its refresh completes', async ({ page }) => {
  let release;
  const waitForListAfterDelete = new Promise(resolve => { release = resolve; });
  const state = await fixture(page, { waitForListAfterDelete });
  await page.goto('/FormSubmissions?status=new');
  await page.getByTestId(`button-view-submission-${id}`).click();
  await page.getByTestId('button-delete-submission').click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete submission', exact: true }).click();
  await expect(page).toHaveURL(/\/FormSubmissions\?status=new$/);
  await expect(page.getByTestId(`button-view-submission-${id}`)).not.toBeVisible();
  await expect(page.getByRole('heading', { name: 'No submissions found' })).toBeVisible();
  release();
  expect(state.deletes).toBe(1);
  expect(state.unexpected).toEqual([]);
});

for (const [name, options, message] of [
  ['portal member without management access', { roleExcluded: ['forms.submissions'] }, 'management access is required'],
  ['per-member denial', { memberExcluded: ['page_FormSubmissions'] }, 'management access is required'],
  ['Due Diligence', { form: { due_diligence_required: true } }, 'Due Diligence Dashboard'],
  ['survey form', { form: { form_type: 'survey' } }, 'immutable'],
  ['survey version', { submission: { survey_version_id: 'synthetic-version' } }, 'immutable'],
  ['survey assignment', { submission: { survey_assignment_id: 'synthetic-assignment' } }, 'immutable'],
  ['missing form', { formMode: 'missing' }, 'loaded successfully'],
  ['failed form', { formMode: 'failed' }, 'loaded successfully'],
  ['missing form reference', { submission: { form_id: null } }, 'loaded successfully'],
]) {
  test(`fails closed: ${name}`, async ({ page }) => {
    const state = await fixture(page, options);
    await page.goto(detail);
    await expect(page.getByTestId('button-delete-submission')).toBeDisabled({ timeout: 20000 });
    await expect(page.locator('#submission-delete-restriction')).toContainText(message);
    expect(state.deletes).toBe(0);
    expect(state.unexpected).toEqual([]);
  });
}

test('metadata loading blocks deletion and failed metadata can be retried', async ({ page }) => {
  let release;
  const waitForForm = new Promise(resolve => { release = resolve; });
  const state = await fixture(page, { waitForForm, formMode: 'failed' });
  await page.goto(detail);
  await expect(page.getByTestId('button-delete-submission')).not.toBeVisible();
  expect(state.deletes).toBe(0);
  release();
  await expect(page.getByRole('button', { name: 'Retry loading form' })).toBeVisible({ timeout: 20000 });
  state.formMode = undefined;
  await page.getByRole('button', { name: 'Retry loading form' }).click();
  await expect(page.getByTestId('button-delete-submission')).toBeEnabled();
});

test('mobile header and confirmation remain usable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await fixture(page);
  const dialog = await openDelete(page);
  await expect(dialog).toBeVisible();
  const confirm = dialog.getByRole('button', { name: 'Delete submission', exact: true });
  await expect(confirm).toBeInViewport();
  await page.screenshot({ path: test.info().outputPath('mobile-confirmation.png') });
  await confirm.click();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/FormSubmissions');
  expect(state.deletes).toBe(1);
  expect(state.unexpected).toEqual([]);
});
