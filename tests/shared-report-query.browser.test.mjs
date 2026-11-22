// Real report viewer against fixture-only HTTP responses; never uses a tenant.
// Run: node --test tests/shared-report-query.browser.test.mjs
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import { normalizeReportViewerQuery, matchesReportViewerQuery } from '../shared/reportViewerQuery.mjs';

let browser, script, css;
const origin = 'http://report-query.example.test';
before(async () => {
  script = (await build({
    stdin: { contents: `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {MemoryRouter, Routes, Route} from 'react-router-dom';
      import Report from './client/src/pages/SharedCustomObjectReport.jsx';
      createRoot(document.getElementById('root')).render(
        <MemoryRouter initialEntries={[window.location.pathname]}><Routes>
          <Route path="/shared-reports/:token" element={<Report />} />
          <Route path="/internal-reports/:objectId/:reportId" element={<Report internalMode />} />
        </Routes></MemoryRouter>
      );`, resolveDir: process.cwd(), loader: 'jsx' },
    bundle: true, write: false, jsx: 'automatic',
    alias: { '@': path.resolve('client/src') }, define: { 'process.env.NODE_ENV': '"test"' },
  })).outputFiles[0].text;
  css = (await postcss([tailwindcss({ content: [
    'client/src/pages/SharedCustomObjectReport.jsx', 'client/src/components/reports/ReportViewerFilters.jsx',
    'client/src/components/ui/{button,input,label}.jsx',
  ] })]).process('@tailwind base; @tailwind components; @tailwind utilities;', { from: undefined })).css;
  browser = await chromium.launch({
    executablePath: execFileSync('which', ['chromium'], { encoding: 'utf8' }).trim(),
    headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
});
after(async () => browser?.close());

for (const internal of [true, false]) test(`${internal ? 'internal desktop' : 'external mobile'} report searches, filters, clears and exports matching rows`, async t => {
  const context = await browser.newContext({ viewport: internal ? { width: 1280, height: 900 } : { width: 402, height: 874 }, acceptDownloads: true });
  t.after(() => context.close());
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  const source = Array.from({ length: 160 }, (_, n) => ({ id: `row-${n}`, values: [`Department ${n}`, n >= 130 ? 'Oxford' : 'London'] }));
  let exportQuery;
  const entry = internal ? '/internal-reports/11111111-1111-4111-8111-111111111111/roster' : '/shared-reports/fixture-capability';
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    assert.equal(url.origin, origin, 'Unexpected external request');
    if (url.pathname === entry) return route.fulfill({ contentType: 'text/html', body: '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div></body></html>' });
    assert.equal(url.pathname, internal ? '/api/internal-reports/view' : '/api/public/custom-object-report');
    const body = route.request().postDataJSON(); requests.push(body);
    const report = { name: 'Department locations', allow_csv: true };
    if (body.action === 'unlock') return route.fulfill({ json: { access_grant: 'fixture-grant', report } });
    if (body.action === 'check') return route.fulfill({ json: { report } });
    if (body.action === 'preview') {
      const query = normalizeReportViewerQuery(body.viewer_query, 2);
      const rows = source.filter(row => matchesReportViewerQuery(row.values, query));
      const current = body.page || 1;
      return route.fulfill({ json: { sort_job: { id: 'snapshot', status: 'complete' },
        columns: [{ label: 'Name' }, { label: 'City' }], data: rows.slice((current - 1) * 50, current * 50),
        page: current, total: rows.length, has_more: current * 50 < rows.length } });
    }
    assert.equal(body.action, 'export');
    if (body.export_action === 'start') exportQuery = normalizeReportViewerQuery(body.viewer_query, 2);
    if (body.export_action === 'chunk') return route.fulfill({ json: { csv_text: 'Name,City\r\n' +
      source.filter(row => matchesReportViewerQuery(row.values, exportQuery)).map(row => row.values.join(',')).join('\r\n') } });
    return route.fulfill({ json: { id: 'export', status: 'complete', chunk_count: 1, filename: 'locations.csv' } });
  });
  await page.goto(origin + entry);
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: script });
  if (!internal) {
    assert.equal(await page.getByRole('searchbox').count(), 0);
    await page.getByRole('button', { name: 'Open report', exact: true }).click();
  }
  await page.getByText('160 rows · page 1', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByText('160 rows · page 2', { exact: true }).waitFor();
  const before = requests.filter(body => body.action === 'preview').length;
  await page.getByRole('searchbox').fill('Ox');
  await page.getByRole('searchbox').fill('OXFORD');
  await page.getByText('30 matching rows · page 1', { exact: true }).waitFor();
  assert.equal(requests.filter(body => body.action === 'preview').length, before + 1);
  assert.equal(requests.at(-1).job_id, 'snapshot');
  await page.getByText('Filter by field', { exact: true }).click();
  await page.getByRole('combobox', { name: 'Match type for Name', exact: true }).selectOption('equals');
  await page.getByRole('textbox', { name: 'Filter Name', exact: true }).fill('Department 159');
  await page.getByText('1 matching rows · page 1', { exact: true }).waitFor();
  assert.equal(await page.locator('tbody tr').count(), 1);
  assert.match(await page.locator('tbody').innerText(), /Department 159/);
  await mkdir('generated-artifacts/report-search', { recursive: true });
  await page.screenshot({ path: `generated-artifacts/report-search/${internal ? 'internal' : 'external-mobile'}.jpg`, fullPage: true });
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download CSV', exact: true }).click();
  const download = await downloadPromise;
  const csv = await readFile(await download.path(), 'utf8');
  assert.match(csv, /Department 159,Oxford/);
  assert.doesNotMatch(csv, /Department 158/);
  await page.getByRole('searchbox').fill('not-found');
  await page.getByText('0 matching rows · page 1', { exact: true }).waitFor();
  await page.getByText('No rows match your search and filters.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Clear search and filters', exact: true }).click();
  await page.getByText('160 rows · page 1', { exact: true }).waitFor();
  assert.deepEqual(errors, []);
});
