import { test, expect } from '@playwright/test';

const slug = 'repeatable-row-visibility-fixture';
const json = (route, body, status = 200) => route.fulfill({
  status, contentType: 'application/json', body: JSON.stringify(body),
});

function fixture(layout) {
  return {
    id: 'repeatable-visibility-browser',
    slug,
    name: 'Row-specific field visibility',
    form_type: 'application',
    layout_type: 'standard',
    is_active: true,
    prefill_source: 'none',
    require_authentication: false,
    allow_save_continue_later: false,
    submit_button_text: 'Submit fixture',
    success_message: 'Fixture submitted.',
    entity_pipelines: { members: [], organisations: [] },
    structured_actions: { version: 1, actions: [] },
    fields: [{
      id: 'people', type: 'repeatable_rows', label: 'People', layout, max_rows: 4,
      children: [
        { id: 'kind', type: 'select', label: 'Kind', options: ['Yes', 'No'], required: true },
        {
          id: 'details', type: 'text', label: 'Details', placeholder: 'Enter details',
          required: true, unique_across_rows: true,
          row_visibility: { mode: 'show_when', source_field_id: 'kind', value: 'Yes' },
        },
        {
          id: 'note', type: 'text', label: 'Note', placeholder: 'Enter note',
          row_visibility: { mode: 'hide_when', source_field_id: 'kind', value: 'Yes' },
        },
      ],
    }],
  };
}

async function install(page, form) {
  const errors = [];
  const submissions = [];
  page.on('pageerror', error => errors.push(error.message));
  const base = process.env.PLAYWRIGHT_BASE_URL || `https://${process.env.REPLIT_DEV_DOMAIN}`;
  await page.context().route('**/*', route => {
    const req = route.request();
    if (new URL(req.url()).origin !== new URL(base).origin) return route.abort();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method())) {
      return json(route, { error: 'Unexpected fixture write' }, 599);
    }
    return route.continue();
  });
  await page.context().route('**/api/**', route => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (!path.startsWith('/api/')) return route.fallback();
    if (path === '/api/auth/me') return json(route, { id: null }, 401);
    if (path === `/api/public/form/${slug}`) return json(route, form);
    if (path === '/api/public/form-submission') {
      submissions.push(req.postDataJSON());
      return json(route, { success: true, id: 'fixture-submission', submission_id: 'fixture-submission' });
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method())) {
      return json(route, { error: 'Unexpected fixture API write' }, 599);
    }
    return json(route, []);
  });
  return { errors, submissions };
}

async function choose(page, row, value) {
  await row.getByRole('combobox').click();
  await page.getByRole('option', { name: value, exact: true }).click();
}

for (const surface of ['standalone', 'embed']) {
  for (const layout of ['cards', 'spreadsheet']) {
    test(`${surface} ${layout}: independent rows, restoration and submission`, async ({ page }) => {
      const state = await install(page, fixture(layout));
      await page.goto(surface === 'embed'
        ? `/embed/form/${slug}?tenant=gsf`
        : `/FormView?slug=${slug}&tenant=gsf`);
      const row = index => page.getByTestId(`repeatable-row-people-${index}`);
      await expect(page.getByTestId('button-add-repeatable-row-people')).toBeVisible();
      const cookieDialog = page.getByRole('dialog', { name: 'Cookie consent' });
      if (await cookieDialog.isVisible()) await cookieDialog.getByRole('button', { name: 'Decline' }).click();
      if (await row(0).count() === 0) {
        await page.getByTestId('button-add-repeatable-row-people').click();
      }
      await expect(row(0)).toBeVisible();
      await expect(row(0).getByPlaceholder('Enter details')).toHaveCount(0);
      await expect(row(0).getByPlaceholder('Enter note')).toBeVisible();
      await choose(page, row(0), 'Yes');
      await row(0).getByPlaceholder('Enter details').fill('Retained first answer');
      await expect(row(0).getByPlaceholder('Enter note')).toHaveCount(0);
      await page.getByTestId('button-add-repeatable-row-people').click();
      await choose(page, row(1), 'No');
      await row(1).getByPlaceholder('Enter note').fill('Second row note');
      await expect(row(1).getByPlaceholder('Enter details')).toHaveCount(0);
      await expect(row(0).getByPlaceholder('Enter details')).toHaveValue('Retained first answer');
      if (layout === 'spreadsheet') {
        const emptyCell = page.getByTestId('repeatable-spreadsheet-cell-people-1-details');
        await expect(emptyCell).toHaveCount(1);
        const hiddenGeometry = await emptyCell.boundingBox();
        const shownGeometry = await page.getByTestId('repeatable-spreadsheet-cell-people-0-details').boundingBox();
        expect(hiddenGeometry.width).toBeGreaterThan(0);
        expect(hiddenGeometry.x).toBe(shownGeometry.x);
        await expect(emptyCell.locator('input,button,select,textarea')).toHaveCount(0);
        await expect(page.getByTestId('repeatable-spreadsheet-header-people')).toContainText('Details');
      }
      await choose(page, row(0), 'No');
      await expect(row(0).getByPlaceholder('Enter details')).toHaveCount(0);
      await choose(page, row(0), 'Yes');
      await expect(row(0).getByPlaceholder('Enter details')).toHaveValue('Retained first answer');
      await page.getByTestId('button-add-repeatable-row-people').click();
      await expect(row(2)).toBeVisible();
      await page.getByTestId('button-remove-repeatable-row-people-2').click();
      await expect(row(2)).toHaveCount(0);
      await choose(page, row(0), 'No');
      // A retained hidden required/unique answer must not block either surface.
      await page.getByRole('button', { name: 'Submit fixture', exact: true }).click();
      await expect.poll(() => state.submissions.length).toBe(1);
      const submitted = state.submissions[0].submission_data;
      expect(submitted.people[0].details).toBe('Retained first answer');
      expect(submitted.people[1].note).toBe('Second row note');
      expect(submitted.people[0]._row_id).not.toBe(submitted.people[1]._row_id);
      expect(state.errors).toEqual([]);
    });
  }
}