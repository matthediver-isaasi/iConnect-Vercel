/**
 * Read-only, authenticated preview verification for Task 4360.
 *
 * Create the storage-state file by signing in normally to the BNMS preview in
 * an interactive Playwright browser. Never commit or print that file.
 *
 *   PLAYWRIGHT_STORAGE_STATE=/tmp/bnms-preview-auth.json \
 *   node scripts/verify-task-4360-preview.mjs
 */
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const TENANT_ID = 'ff2df806-b321-4254-b651-3af11fccf1db';
const FIELD_KEY = 'object-field:30ad9dde-4b4e-4991-a7a4-8ef2b6b5138e:target:cd1ebfd3-3e16-4091-be5a-99992d926f2f:35e4f2dd-6f22-4875-8d2f-4ffb05b1980f';
const baseUrl = (process.env.PLAYWRIGHT_BASE_URL || 'https://bnms.dev.iconn.app').replace(/\/$/, '');
const storageState = process.env.PLAYWRIGHT_STORAGE_STATE;
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  || process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE
  || undefined;

if (!storageState) {
  throw new Error('PLAYWRIGHT_STORAGE_STATE is required; sign in normally and save a temporary Playwright storage state');
}
await access(storageState);

const browser = await chromium.launch({
  headless: process.env.PLAYWRIGHT_HEADLESS !== 'false',
  ...(executablePath ? { executablePath } : {}),
});

try {
  const context = await browser.newContext({ baseURL: baseUrl, storageState });
  const page = await context.newPage();
  const observed = {
    metadata: null,
    initialSearch: null,
    options: null,
    filteredSearch: null,
    unexpectedMutations: [],
  };

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const readOnlyPost = method === 'POST'
      && url.pathname === '/api/organisation-directory/filters';
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && !readOnlyPost) {
      observed.unexpectedMutations.push(`${method} ${url.pathname}`);
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });

  page.on('response', async (response) => {
    const request = response.request();
    const url = new URL(response.url());
    if (url.pathname !== '/api/organisation-directory/filters' || !response.ok()) return;
    try {
      const payload = await response.json();
      if (request.method() === 'GET') {
        observed.metadata = payload;
        return;
      }
      const body = request.postDataJSON();
      if (body?.action === 'options') {
        observed.options = payload;
      } else if (body?.filters?.[FIELD_KEY]) {
        observed.filteredSearch = payload;
      } else {
        observed.initialSearch = payload;
      }
    } catch {
      // Assertions below provide a non-sensitive failure if a response is not JSON.
    }
  });

  const authResponse = await context.request.get('/api/auth/tenant-user-me');
  assert.equal(authResponse.ok(), true, 'saved browser state is not authenticated on the preview');
  const auth = await authResponse.json();
  assert.equal(
    String(auth?.tenant?.id || auth?.user?.tenant_id),
    TENANT_ID,
    'saved browser state belongs to a different tenant',
  );

  await page.goto('/OrganisationDirectory');
  await page.getByRole('heading', { name: 'Organisation Directory' }).waitFor();
  await page.waitForFunction(() => {
    const text = document.body.innerText;
    return !text.includes('Organisation inventory exceeds the supported size')
      && !text.includes('Failed to load organisation directory filters');
  });

  await page.waitForFunction(
    ({ key }) => Boolean(document.querySelector(`[data-testid="filter-${CSS.escape(key)}"]`)),
    { key: FIELD_KEY },
  );
  await page.getByRole('radiogroup', { name: 'Organisation department: Name (Departments) options' })
    .waitFor();

  await assert.doesNotReject(async () => {
    await page.waitForFunction(() => document.querySelectorAll('[role="radiogroup"] input[type="radio"]').length > 0);
  }, 'destination-backed department options did not load');

  const firstOption = page.getByRole('radiogroup', {
    name: 'Organisation department: Name (Departments) options',
  }).locator('input[type="radio"]').first();
  await firstOption.check();
  await page.waitForFunction(() => {
    const count = document.querySelectorAll('[data-testid^="card-organisation-"]').length;
    return count > 0;
  });

  assert.equal(observed.metadata?.fields?.find((field) => field.key === FIELD_KEY)?.control, 'source-choice');
  assert.ok(observed.initialSearch?.total >= 279 && observed.initialSearch.total <= 280);
  assert.equal(observed.options?.total, 7);
  assert.ok(observed.filteredSearch?.total > 0);
  assert.equal(observed.unexpectedMutations.length, 0, 'the directory attempted an unexpected mutating API request');

  console.log(JSON.stringify({
    previewHost: new URL(baseUrl).hostname,
    authenticatedTenant: 'BNMS',
    configuredDepartmentNameFilter: true,
    sourceChoiceControl: true,
    initialEligibleTotalInExpectedRange: true,
    distinctDepartmentOptions: observed.options.total,
    selectedOptionReturnedResults: true,
    unexpectedMutations: 0,
  }));
  await context.close();
} finally {
  await browser.close();
}