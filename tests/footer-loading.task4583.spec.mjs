import { test, expect } from '@playwright/test';

const TENANTS = {
  member: { id: 'tenant-footer-member', name: 'Member Footer Tenant' },
  admin: { id: 'tenant-footer-admin', name: 'Admin Footer Tenant' },
};
const ROLE = {
  id: 'role-footer-manager',
  tenant_id: TENANTS.member.id,
  name: 'Communications manager',
  excluded_features: [],
};
const MEMBER = {
  id: 'member-footer-manager',
  tenant_id: TENANTS.member.id,
  role_id: ROLE.id,
  email: 'footer-manager@example.invalid',
  first_name: 'Footer',
  last_name: 'Manager',
  member_excluded_features: [],
  sessionRole: {
    status: 'ready',
    member_id: 'member-footer-manager',
    tenant_id: TENANTS.member.id,
    role_id: ROLE.id,
    role: ROLE,
  },
};
const SAVED_FOOTER = [
  '<table data-footer="saved"><tr><td>',
  '<a data-social="linkedin" href="{{linkedin_url}}">Saved tenant footer</a>',
  '</td></tr></table>',
].join('');
const SOCIAL_ICONS = [{
  platform: 'LinkedIn',
  url: 'https://www.linkedin.com/company/footer-fixture',
}];

function deferred() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    headers: { 'Cache-Control': 'private, no-store' },
    body: JSON.stringify(body),
  });
}

function setting(tenantId, key, value, id = `setting-${key}`) {
  return { id, tenant_id: tenantId, setting_key: key, setting_value: value };
}

async function installFixture(page, {
  audience = 'member',
  footer = SAVED_FOOTER,
  socialIcons = SOCIAL_ICONS,
  settingsError = false,
  holdSettings = false,
} = {}) {
  const gate = deferred();
  if (!holdSettings) gate.release();
  const state = {
    audience,
    footer,
    socialIcons,
    settingsError,
    requests: [],
    writes: [],
    unexpectedWrites: [],
    unexpectedReads: [],
    pageErrors: [],
    consoleErrors: [],
    releaseSettings: gate.release,
  };
  page.on('pageerror', error => state.pageErrors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error'
      && !message.text().includes('Failed to load resource: the server responded with a status of 500')) {
      state.consoleErrors.push(message.text());
    }
  });

  await page.addInitScript(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    if (url.pathname.startsWith('/rest/v1/')) {
      if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
        state.unexpectedWrites.push(`${method} ${url.pathname}`);
        return json(route, { error: 'Unexpected direct database mutation' }, 599);
      }
      return json(route, []);
    }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const key = `${method} ${url.pathname}${url.search}`;
    state.requests.push({
      key,
      method,
      path: url.pathname,
      search: url.search,
      headers: request.headers(),
    });

    const tenant = audience === 'admin' ? TENANTS.admin : TENANTS.member;
    if (url.pathname === '/api/auth/tenant-user-me') {
      if (audience === 'admin') {
        return json(route, {
          authenticated: true,
          user: { id: 'tenant-user-footer-admin', email: 'admin@example.invalid' },
          tenant: { ...TENANTS.admin, slug: 'footer-admin' },
        });
      }
      return json(route, { authenticated: false });
    }
    if (url.pathname === '/api/auth/me') {
      if (audience === 'member') return json(route, MEMBER);
      const adminRole = { ...ROLE, tenant_id: TENANTS.admin.id };
      return json(route, {
        ...MEMBER,
        tenant_id: TENANTS.admin.id,
        sessionRole: {
          ...MEMBER.sessionRole,
          tenant_id: TENANTS.admin.id,
          role: adminRole,
        },
      });
    }
    if (url.pathname === `/api/entities/Role/${ROLE.id}`) return json(route, ROLE);
    if (url.pathname === '/api/entities/Role') return json(route, [ROLE]);
    if (url.pathname === '/api/entities/EmailTemplate') return json(route, []);
    if (url.pathname === '/api/entities/SystemSettings' && method === 'GET') {
      if (!url.searchParams.has('filter')) return json(route, []);
      await gate.promise;
      if (state.settingsError) return json(route, { error: 'Footer settings unavailable' }, 500);
      let filter = {};
      try {
        filter = JSON.parse(url.searchParams.get('filter') || '{}');
      } catch {
        return json(route, { error: 'Invalid fixture filter' }, 400);
      }
      if (filter.setting_key === 'email_footer_html') {
        return json(route, state.footer === null
          ? []
          : [setting(tenant.id, 'email_footer_html', state.footer, 'footer-setting-id')]);
      }
      if (filter.setting_key === 'social_icons_config') {
        return json(route, state.socialIcons === null
          ? []
          : [setting(tenant.id, 'social_icons_config', JSON.stringify(state.socialIcons), 'social-setting-id')]);
      }
      state.unexpectedReads.push(key);
      return json(route, { error: `Unexpected settings read: ${key}` }, 599);
    }
    if (url.pathname === '/api/entities/SystemSettings/footer-setting-id' && method === 'PATCH') {
      const body = request.postDataJSON();
      state.writes.push({ method, path: url.pathname, body, headers: request.headers() });
      state.footer = body.setting_value;
      return json(route, setting(tenant.id, 'email_footer_html', state.footer, 'footer-setting-id'));
    }
    if (url.pathname === '/api/entities/SystemSettings' && method === 'POST') {
      const body = request.postDataJSON();
      state.writes.push({ method, path: url.pathname, body, headers: request.headers() });
      state.footer = body.setting_value;
      return json(route, setting(tenant.id, body.setting_key, body.setting_value, 'new-footer-setting-id'));
    }

    // Harmless reads from the shared application shell are fixture-isolated.
    if (['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      if (url.pathname === '/api/public/tenant-branding') {
        return json(route, {
          success: true,
          branding: {
            id: tenant.id,
            name: tenant.name,
            headerConfig: {},
            footerConfig: {},
            platformBranding: { enabled: false },
          },
        });
      }
      if (url.pathname === '/api/public/favicon-url') return json(route, { faviconUrl: null });
      if (url.pathname === '/api/public/platform-defaults'
        || url.pathname === '/api/public/portal-branding'
        || url.pathname === '/api/public/ai-help-persona'
        || url.pathname === '/api/tenant-canvas-theme') return json(route, {});
      if (url.pathname === '/api/communication/inbox/unread-count') return json(route, { unreadCount: 0 });
      return json(route, []);
    }

    state.unexpectedWrites.push(key);
    return json(route, { error: `Unexpected mutation: ${key}` }, 599);
  });
  return state;
}

async function openFooter(page) {
  await expect(page.getByTestId('text-page-title')).toHaveText('Email Templates');
  await page.getByText('Email Footer', { exact: true }).click();
}

function expectCleanFixture(state) {
  expect(state.unexpectedWrites).toEqual([]);
  expect(state.unexpectedReads).toEqual([]);
  expect(state.pageErrors).toEqual([]);
  expect(state.consoleErrors).toEqual([]);
}

function footerReads(state) {
  return state.requests.filter(({ path, method, search }) => (
    path === '/api/entities/SystemSettings' && method === 'GET'
      && new URLSearchParams(search).has('filter')
  ));
}

test('member direct entry resolves tenant from auth/me and loads exact saved footer plus social preview', async ({ page }, testInfo) => {
  const state = await installFixture(page, { audience: 'member' });
  await page.goto('/EmailTemplateManagement');
  await openFooter(page);

  await expect(page.getByTestId('textarea-footer-html')).toHaveValue(SAVED_FOOTER);
  const reads = footerReads(state);
  expect(reads).toHaveLength(2);
  expect(reads.map(({ search }) => JSON.parse(new URLSearchParams(search).get('filter')).setting_key).sort())
    .toEqual(['email_footer_html', 'social_icons_config']);
  expect(reads.every(({ headers }) => headers['x-tenant-id'] === TENANTS.member.id)).toBe(true);

  await page.getByTestId('button-preview-footer').click();
  const dialog = page.getByRole('dialog', { name: 'Email Footer Preview' });
  await expect(dialog.getByText('Saved tenant footer')).toBeVisible();
  await expect(dialog.locator('[data-social="linkedin"]')).toHaveAttribute('href', SOCIAL_ICONS[0].url);
  await expect(dialog.getByText(/Social links detected:\s*LinkedIn/)).toBeVisible();
  const screenshot = testInfo.outputPath('member-saved-footer-preview.png');
  await page.screenshot({ path: screenshot, fullPage: false });
  await testInfo.attach('member-saved-footer-preview.png', { path: screenshot, contentType: 'image/png' });

  expect(state.writes).toEqual([]);
  expectCleanFixture(state);
});

test('tenant admin direct entry resolves tenant-user context and updates the existing setting only', async ({ page }) => {
  const state = await installFixture(page, { audience: 'admin' });
  await page.goto('/EmailTemplateManagement');
  await openFooter(page);

  await expect(page.getByTestId('textarea-footer-html')).toHaveValue(SAVED_FOOTER);
  await page.getByTestId('textarea-footer-html').fill('<footer>Admin updated footer</footer>');
  await page.getByTestId('button-save-footer').click();
  await expect.poll(() => state.writes.length).toBe(1);
  expect(state.writes[0]).toMatchObject({
    method: 'PATCH',
    path: '/api/entities/SystemSettings/footer-setting-id',
    body: { setting_value: '<footer>Admin updated footer</footer>' },
  });
  expect(state.writes[0].headers['x-tenant-id']).toBe(TENANTS.admin.id);
  expectCleanFixture(state);
});

test('missing footer is an explicit empty ready state and save creates the tenant setting', async ({ page }) => {
  const state = await installFixture(page, { audience: 'member', footer: null, socialIcons: null });
  await page.goto('/EmailTemplateManagement');
  await openFooter(page);

  await expect(page.getByTestId('textarea-footer-html')).toHaveValue('');
  await page.getByTestId('textarea-footer-html').fill('<footer>First configured footer</footer>');
  await page.getByTestId('button-save-footer').click();
  await expect.poll(() => state.writes.length).toBe(1);
  expect(state.writes[0]).toMatchObject({
    method: 'POST',
    path: '/api/entities/SystemSettings',
    body: {
      setting_key: 'email_footer_html',
      setting_value: '<footer>First configured footer</footer>',
      description: 'HTML footer appended to all outgoing emails',
    },
  });
  expect(state.writes[0].headers['x-tenant-id']).toBe(TENANTS.member.id);
  expectCleanFixture(state);
});

test('delayed load never exposes a blank editable footer or permits a destructive write', async ({ page }) => {
  const state = await installFixture(page, { audience: 'member', holdSettings: true });
  await page.goto('/EmailTemplateManagement');
  await openFooter(page);

  await expect(page.getByTestId('button-save-footer')).toBeDisabled();
  await expect(page.getByTestId('textarea-footer-html')).toBeDisabled();
  await expect(page.getByTestId('textarea-footer-html')).toHaveValue('');
  expect(state.writes).toEqual([]);

  state.releaseSettings();
  await expect(page.getByTestId('textarea-footer-html')).toHaveValue(SAVED_FOOTER);
  await expect(page.getByTestId('button-save-footer')).toBeEnabled();
  expect(state.writes).toEqual([]);
  expectCleanFixture(state);
});

test('settings failure is visible, preserves write safety, and retry restores the saved footer', async ({ page }) => {
  const state = await installFixture(page, { audience: 'member', settingsError: true });
  await page.goto('/EmailTemplateManagement');
  await openFooter(page);

  await expect(page.getByText(/Footer settings unavailable/i)).toBeVisible();
  await expect(page.getByTestId('button-save-footer')).toBeDisabled();
  await expect(page.getByTestId('textarea-footer-html')).toBeDisabled();
  await expect(page.getByTestId('textarea-footer-html')).toHaveValue('');
  expect(state.writes).toEqual([]);

  state.settingsError = false;
  await page.getByRole('button', { name: /retry/i }).click();
  await expect(page.getByTestId('textarea-footer-html')).toHaveValue(SAVED_FOOTER);
  expect(state.writes).toEqual([]);
  expectCleanFixture(state);
});