import { test, expect } from '@playwright/test';
const objectId = '11111111-1111-4111-8111-111111111111';
async function mount(page, { denied = false } = {}) {
  let revoked = false;
  const calls = [];
  await page.route('**/api/internal-reports/view', async route => {
    const body = route.request().postDataJSON();
    calls.push(body);
    if (denied || revoked) return route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"Report unavailable"}' });
    const result = body.action === 'unlock'
      ? { access_grant: 'fixture-internal-grant', report: { name: 'Internal workforce report', allow_csv: false } }
      : body.action === 'check' ? { report: { name: 'Internal workforce report', allow_csv: false } }
        : { sort_job: { id: 'snapshot', status: 'complete' }, columns: [{ label: 'Department' }],
          data: [{ id: 'row-0', values: ['Imaging'] }], total: 1, page: 1, pageSize: 50 };
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(result) });
  });
  await page.route('**/__internal-report-fixture', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><link rel="stylesheet" href="/src/index.css"></head><body><div id="root"></div>
<script type="module">
import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => type => type;
window.__vite_plugin_react_preamble_installed__ = true;
const source = await (await fetch('/src/pages/SharedCustomObjectReport.jsx')).text();
const dep = name => source.match(new RegExp('from "([^"]*/'+name+'\\\\.js[^"]*)"'))[1];
const React = (await import(dep('react'))).default;
const {createRoot} = (await import(dep('react').replace(/react\\.js/, 'react-dom_client.js'))).default;
const {MemoryRouter, Routes, Route} = await import(dep('react-router-dom'));
const {default: Viewer} = await import('/src/pages/SharedCustomObjectReport.jsx');
createRoot(document.getElementById('root')).render(React.createElement(MemoryRouter,{initialEntries:['/internal-reports/${objectId}/r_report']},
  React.createElement(Routes,null,React.createElement(Route,{path:'/internal-reports/:objectId/:reportId',element:React.createElement(Viewer,{internalMode:true})}))));
</script></body></html>` }));
  await page.goto('/__internal-report-fixture');
  return { calls, revoke: () => { revoked = true; } };
}
test('internal viewer uses normal session transport, automatically opens without a password, and clears revoked data', async ({ page }, testInfo) => {
  const fixture = await mount(page);
  await expect(page.getByRole('heading', { name: 'Internal workforce report' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Imaging' })).toBeVisible();
  await expect(page.locator('input[type=password]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Download CSV' })).toHaveCount(0);
  expect(fixture.calls.every(body => body.object_id === objectId && body.report_id === 'r_report' && !body.token && !body.password)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('internal-report.png'), fullPage: true });
  fixture.revoke();
  await page.getByRole('button', { name: 'Refresh data' }).click();
  await expect(page.getByRole('cell', { name: 'Imaging' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Internal workforce report' })).toHaveCount(0);
});
test('a role denied access never fetches preview rows or sees report metadata', async ({ page }) => {
  const fixture = await mount(page, { denied: true });
  await expect(page.getByText('Report unavailable')).toBeVisible();
  await expect(page.locator('table')).toHaveCount(0);
  await expect(page.locator('input[type=password]')).toHaveCount(0);
  expect(fixture.calls.map(body => body.action)).toEqual(['unlock']);
});
