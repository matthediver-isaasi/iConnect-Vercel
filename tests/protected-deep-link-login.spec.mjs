import { test, expect } from '@playwright/test';

// A signed-out visitor opening a protected submission deep link must go
// straight to login (no public chrome, no protected reads) and return to the
// exact original link, including query and hash, after signing in.
const id = '2f0e8c1a-7d3b-4c9e-9a51-6b2d8e4f1c30';
const original = `/FormSubmission/${id}?back=${encodeURIComponent('/FormSubmissions?status=new')}#notes`;
const form = { id: 'deep-link-form', name: 'Deep link application', is_active: true, form_type: 'standard', fields: [] };
const submission = {
  id, form_id: form.id, form_name: form.name, status: 'new',
  submitted_by_name: 'Deep Link Applicant', created_date: '2026-10-01T12:00:00Z', submission_data: {},
};
const member = {
  id: 'deep-link-admin', tenant_id: 'fixture', role_id: 'deep-link-role',
  email: 'admin@example.invalid', member_excluded_features: [], is_team_member: false,
};
const role = { id: member.role_id, name: 'Administrator', excluded_features: [] };

async function fixture(page) {
  const state = { signedIn: false, guestProtectedReads: [], logins: 0 };
  await page.context().route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== new URL(test.info().project.use.baseURL).origin) return route.abort();
    const path = url.pathname;
    if (!path.startsWith('/api/')) return route.continue();
    const json = (body, status = 200) => route.fulfill({ status, json: body });
    if (path === '/api/auth/login' && request.method() === 'POST') {
      state.logins++;
      state.signedIn = true;
      return json({ success: true, member });
    }
    if (path === '/api/auth/me') return json(state.signedIn ? member : null);
    if (path === '/api/auth/tenant-user-me') {
      return state.signedIn ? json({ user: member, tenant: { id: member.tenant_id } }) : json(null, 401);
    }
    if (path.startsWith('/api/auth/')) return json({});
    const protectedRead = path.startsWith('/api/entities/') || path.startsWith('/api/admin/');
    if (!state.signedIn && protectedRead) {
      state.guestProtectedReads.push(`${request.method()} ${path}`);
      return json({ error: 'Not authenticated' }, 401);
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) return json({});
    if (path === '/api/entities/Member') return json([member]);
    if (path === `/api/entities/Member/${member.id}`) return json(member);
    if (path === '/api/entities/Role') return json([role]);
    if (path === `/api/entities/Role/${role.id}`) return json(role);
    if (path === `/api/entities/Form/${form.id}`) return json(form);
    if (path === `/api/entities/FormSubmission/${id}`) return json(submission);
    return json([]);
  });
  return state;
}

test('signed-out submission deep link goes straight to login and returns after sign-in', async ({ page }) => {
  const state = await fixture(page);
  // Record any portal/public chrome painted while still on the deep link.
  const chromeOnDeepLink = [];
  await page.exposeFunction('reportDeepLinkChrome', tag => chromeOnDeepLink.push(tag));
  await page.addInitScript(() => {
    const check = () => {
      if (!location.pathname.startsWith('/FormSubmission/')) return;
      // Hidden portal chrome (behind the readiness gate) is not a render.
      for (const chrome of document.querySelectorAll('header, nav, footer, aside')) {
        if (chrome.checkVisibility()) window.reportDeepLinkChrome(chrome.outerHTML.slice(0, 120));
      }
    };
    new MutationObserver(check).observe(document, { childList: true, subtree: true });
  });

  await page.goto(original);
  await expect(page).toHaveURL(/\/login\?returnTo=/i, { timeout: 30000 });
  const loginUrl = new URL(page.url());
  expect(loginUrl.searchParams.get('returnTo')).toBe(original);
  expect(loginUrl.search).toContain(encodeURIComponent(original));
  expect(chromeOnDeepLink).toEqual([]);
  expect(state.guestProtectedReads.filter(read => /FormSubmission|Form\/|Organization/.test(read))).toEqual([]);

  await page.getByTestId('input-email').fill(member.email);
  await page.getByTestId('input-password').fill('synthetic-password');
  await page.getByTestId('button-login').click();
  await expect.poll(() => {
    const current = new URL(page.url());
    return current.pathname + current.search + current.hash;
  }, { timeout: 30000 }).toBe(original);
  expect(state.logins).toBe(1);
  await expect(page.getByText('Deep Link Applicant').first()).toBeVisible({ timeout: 30000 });
});
