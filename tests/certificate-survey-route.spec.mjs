import { test, expect } from '@playwright/test';

// Synthetic credentials only; every API call is intercepted, including writes.
const credential = 'c'.repeat(43);
async function fixture(page, { visibility = {}, denied = false, missingBootstrap = false, canonicalRedirect = false } = {}) {
  const grants = [];
  const writes = [];
  await page.context().routeWebSocket('**/*', socket => socket.onMessage(() => {}));
  await page.context().route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const virtualHost = canonicalRedirect && ['fixture.iconn.app', 'approved.example.org'].includes(url.hostname);
    if (url.origin !== 'http://127.0.0.1:5000' && !virtualHost) {
      return route.fulfill({ status: 204, body: '' });
    }
    if (!url.pathname.startsWith('/api/')) {
      if (virtualHost || (missingBootstrap && request.isNavigationRequest())) {
        const response = await route.fetch({ url: `http://127.0.0.1:5000${url.pathname}${url.search}` });
        if (missingBootstrap && request.isNavigationRequest()) {
          const body = (await response.text()).replace(/<script>\s*\/\/ Strip invitation credentials[\s\S]*?<\/script>/, '');
          return route.fulfill({ response, body });
        }
        return route.fulfill({ response });
      }
      return route.continue();
    }
    const json = (body, status = 200) => route.fulfill({
      status, contentType: 'application/json', body: JSON.stringify(body),
    });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
      writes.push(url.pathname);
      return json({ error: 'No writes allowed' }, 599);
    }
    if (url.pathname.startsWith('/api/auth/')) return json({ error: 'Logged out' }, 401);
    if (url.pathname === '/api/public/tenant-redirect') return json({ redirectTo: 'approved.example.org' });
    if (url.pathname.includes('system-setting') && url.href.includes('page_visibility_settings')) {
      return json([{ setting_value: JSON.stringify(visibility) }]);
    }
    if (url.pathname === '/api/public/survey-assignment/fixture-assignment') {
      const grant = request.headers()['x-certificate-survey-grant'];
      grants.push(grant);
      if (denied) return json({ error: 'Survey invitation unavailable' }, 403);
      if (grant !== credential) return json({ require_authentication: true });
      return json({
        access: { allowed: true, code: 'CERTIFICATE_INVITATION' },
        assignment: { token: 'fixture-assignment', window_state: 'open', access_mode: 'authenticated' },
        form: { id: 'fixture-survey', name: 'Guest invitation survey', form_type: 'survey',
          is_active: true, fields: [{ id: 'feedback', type: 'text', label: 'Your feedback' }],
          pages: [], visibility_rules: [], survey_settings: { status: 'published', current_version: 1 } },
      });
    }
    return json([]);
  });
  return { grants, writes };
}

test('logged-out certificate route renders despite generic FormView portal visibility', async ({ page }) => {
  test.setTimeout(120_000);
  const state = await fixture(page, { visibility: { FormView: 'portal' } });
  await page.goto(`/survey/fixture-assignment#certificate_grant=${credential}`);
  await expect(page.getByText('Your feedback', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/survey\/fixture-assignment$/);
  expect(state.grants).toContain(credential);
  await page.reload();
  await expect(page.getByText('Your feedback', { exact: true })).toBeVisible();
  expect(state.writes).toEqual([]);
  await page.screenshot({ path: '/tmp/certificate-survey-logged-out.jpg', fullPage: true });
});

test('invalid or expired invitation stays denied without login or public fallback', async ({ page }) => {
  const state = await fixture(page, { denied: true });
  await page.goto(`/survey/fixture-assignment#certificate_grant=${credential}`);
  await expect(page.getByText('This survey invitation has expired or is no longer available.')).toBeVisible();
  await expect(page).toHaveURL(/\/survey\/fixture-assignment$/);
  expect(state.grants).toEqual([credential]);
  expect(state.writes).toEqual([]);
});

test('ordinary authenticated assignment still requires login', async ({ page }) => {
  const state = await fixture(page);
  await page.goto('/survey/fixture-assignment');
  await expect(page).toHaveURL(/\/login\?returnTo=/);
  expect(state.grants).toEqual([undefined]);
  expect(state.writes).toEqual([]);
});

test('missing HTML bootstrap still opens the actual logged-out token route', async ({ page }) => {
  const state = await fixture(page, { missingBootstrap: true });
  await page.goto(`/survey/fixture-assignment#certificate_grant=${credential}`);
  await expect(page.getByText('Your feedback', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/survey\/fixture-assignment$/);
  expect(state.grants).toContain(credential);
  expect(state.writes).toEqual([]);
});

test('approved canonical-domain redirect preserves stripped invitation across origins', async ({ page }) => {
  const state = await fixture(page, { canonicalRedirect: true });
  await page.goto(`http://fixture.iconn.app/survey/fixture-assignment#certificate_grant=${credential}`);
  await expect(page).toHaveURL('https://approved.example.org/survey/fixture-assignment');
  await expect(page.getByText('Your feedback', { exact: true })).toBeVisible();
  expect(state.grants).toContain(credential);
  expect(state.writes).toEqual([]);
});