import { test, expect } from '@playwright/test';
import { installCommunicationReportFixture } from './member-communication-status.fixture.mjs';

for (const blocked of [false, true]) test(`dashboard swap ${blocked ? 'blocks invalid mapping' : 'confirms compatible mapping'}`, async ({ page, baseURL }) => {
  await installCommunicationReportFixture(page, baseURL);
  await page.route('**/DueDiligenceDashboard', route => route.continue());
  let executions = 0;
  const forms = ['source', 'target'].map(id => ({ id, name: id === 'target' ? 'ESO Long form' : 'Source form', due_diligence_required: true, fields: [] }));
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const json = body => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/entities/Form') return json(forms);
    if (path === '/api/entities/FormDueDiligenceConfig') return json(forms.map(f => ({ form_id: f.id, workflow_stages: [{ id: 'new', label: 'New' }] })));
    if (path === '/api/due-diligence/list-submissions') return json({ submissions: [{ id: 'dd-fixture', form_name: 'Source form', application_uid: 'DD-fixture', workflow_status: 'new', form_submission: { form_id: 'source' } }], total: 1 });
    if (path === '/api/due-diligence/swap-preview') return json({ preview: {
      sourceForm: forms[0], targetForm: forms[1], canSwap: !blocked,
      problems: blocked ? [{ fieldId: 'org', fieldLabel: 'Name of organisation', message: 'The saved selection is unavailable.' }] : [],
      fieldMapping: { mapped: [], newEmpty: [], ignored: [] },
      contractStatus: { willRelink: [], willArchive: [], totalActive: 0 },
      summary: { fieldsToMap: 0, fieldsWithValues: 0, newEmptyFieldsCount: 0, requiredEmptyFields: 0, ignoredFieldsCount: 0, ignoredFieldsWithValues: 0 },
    } });
    if (path === '/api/due-diligence/swap-execute') {
      executions++;
      expect(blocked).toBe(false);
      return json({ success: true, newSubmission: {} });
    }
    return route.fallback();
  });
  await page.goto('/DueDiligenceDashboard', { waitUntil: 'domcontentloaded' });
  await page.getByTestId('select-swap-form-dd-fixture').click();
  await page.getByRole('option', { name: 'ESO Long form' }).click();
  const confirm = page.getByTestId('button-confirm-swap');
  if (blocked) {
    await expect(page.getByRole('alert').filter({ hasText: 'Name of organisation' })).toBeVisible();
    await expect(confirm).toBeDisabled();
    expect(executions).toBe(0);
  } else {
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect.poll(() => executions).toBe(1);
  }
});
