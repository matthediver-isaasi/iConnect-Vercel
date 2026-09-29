import { test, expect } from '@playwright/test';

// Browser-only fixture: no database or email requests leave this page.
const grant = 'c'.repeat(43);
const assignmentPath = '/api/public/survey-assignment/fixture-assignment';
const fields = [
  { id: 'first', type: 'text', label: 'First name', prefill_field: 'member:first_name' },
  { id: 'last', type: 'text', label: 'Last name', prefill_field: 'member:last_name' },
  { id: 'email', type: 'text', label: 'Email', prefill_field: 'member:email' },
  { id: 'org', type: 'text', label: 'Organisation', prefill_field: 'org:name' },
  { id: 'defaulted', type: 'text', label: 'Default answer', default_value: 'Published default', prefill_field: 'member:job_title' },
  { id: 'notes', type: 'text', label: 'My notes' },
];
// Form fields mirror the immutable published survey_version snapshot, not
// mutable form-builder fields.
const form = {
  id: 'fixture-survey', name: 'Invitation confirmation fixture', form_type: 'survey',
  is_active: true, fields, pages: [], visibility_rules: [],
  survey_settings: { status: 'published', current_version: 1 },
};
const response = invitationPrefill => ({
  access: { allowed: true, code: 'CERTIFICATE_INVITATION' },
  assignment: { token: 'fixture-assignment', window_state: 'open', access_mode: 'authenticated' },
  form,
  invitation_prefill: invitationPrefill,
});

async function fixture(page, { canConfirm = true } = {}) {
  const state = { posts: [], memberReads: [], unexpectedWrites: [], grants: [] };
  let confirmed = false;
  await page.context().routeWebSocket('**/*', socket => socket.onMessage(() => {}));
  await page.context().route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== 'http://127.0.0.1:5000') return route.fulfill({ status: 204, body: '' });
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const json = (body, status = 200) => route.fulfill({
      status, contentType: 'application/json', body: JSON.stringify(body),
    });
    if (/member|organization|organisation|custom.value/i.test(url.pathname)
      && url.pathname !== assignmentPath) state.memberReads.push(`${request.method()} ${url.pathname}`);
    if (url.pathname === assignmentPath) {
      state.grants.push(request.headers()['x-certificate-survey-grant']);
      if (request.headers()['x-certificate-survey-grant'] !== grant) {
        return json({ require_authentication: true });
      }
      if (request.method() === 'POST') {
        state.posts.push({
          url: request.url(), headers: request.headers(), body: request.postDataJSON(),
        });
        if (JSON.stringify(request.postDataJSON()) !== '{"action":"confirm_attendee"}') {
          return json({ error: 'Unexpected confirmation payload' }, 400);
        }
        confirmed = true;
      }
      if (request.method() !== 'GET' && request.method() !== 'POST') {
        state.unexpectedWrites.push(`${request.method()} ${url.pathname}`);
        return json({ error: 'Unexpected write' }, 599);
      }
      return json(response(confirmed ? {
        association: { status: 'linked', can_confirm: false },
        values: {
          first: 'Linked member', last: 'Linked surname', email: 'linked@example.test',
          org: 'Linked organisation', defaulted: 'Linked position',
        },
        unavailable: [],
      } : {
        association: { status: 'unlinked', can_confirm: canConfirm },
        values: { first: 'Invited attendee', email: 'invited@example.test' },
        unavailable: [],
      }));
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
      state.unexpectedWrites.push(`${request.method()} ${url.pathname}`);
      return json({ error: 'No writes allowed' }, 599);
    }
    if (url.pathname.startsWith('/api/auth/')) return json({ error: 'Logged out' }, 401);
    return json([]);
  });
  return state;
}

test('confirmation uses grant-only action and merges linked snapshot fields without replacing defaults or edits', async ({ page }) => {
  const state = await fixture(page);
  await page.goto(`/survey/fixture-assignment#certificate_grant=${grant}`);
  // Legacy FormRenderer text inputs have adjacent visible labels, but no
  // associated accessible name. Assert the snapshot labels and use its order.
  for (const field of fields) {
    await expect(page.getByRole('main').getByText(field.label, { exact: true })).toBeVisible();
  }
  const inputs = page.getByRole('main').getByRole('textbox');
  await expect(inputs).toHaveCount(fields.length);
  const [first, last, email, org, defaulted, notes] = fields.map((_, index) => inputs.nth(index));
  await expect(page.getByRole('button', { name: 'Use my member details' })).toBeVisible();
  await expect(first).toHaveValue('Invited attendee');
  await expect(email).toHaveValue('invited@example.test');
  await expect(defaulted).toHaveValue('Published default');
  await first.fill('My edited name');
  await email.fill(''); // Intentionally cleared: server prefill must not restore it.
  await notes.fill('My own answer');
  const confirmationResponse = page.waitForResponse(request =>
    new URL(request.url()).pathname === assignmentPath && request.request().method() === 'POST');
  await page.getByRole('button', { name: 'Use my member details' }).click();
  expect((await confirmationResponse).status()).toBe(200);
  await expect.poll(() => state.posts.length).toBe(1);
  expect(new URL(state.posts[0].url).pathname).toBe(assignmentPath);
  expect(new URL(state.posts[0].url).searchParams.has('member_id')).toBe(false);
  expect(state.posts[0].headers['x-certificate-survey-grant']).toBe(grant);
  expect(state.posts[0].body).toEqual({ action: 'confirm_attendee' });
  await page.screenshot({ path: '/tmp/task-4847-confirmed-invitation.jpg', fullPage: true });
  await expect(page.getByTestId('survey-attendee-confirmation')).toHaveCount(0);
  await expect(last).toHaveValue('Linked surname');
  await expect(org).toHaveValue('Linked organisation');
  await expect(first).toHaveValue('My edited name');
  await expect(email).toHaveValue('');
  await expect(defaulted).toHaveValue('Published default');
  await expect(notes).toHaveValue('My own answer');
  expect(state.posts).toHaveLength(1);
  expect(state.grants).toContain(grant);
  expect(state.memberReads).toEqual([]);
  expect(state.unexpectedWrites).toEqual([]);
});

test('logged-out unlinked invitation offers sign-in, not confirmation or broad member reads', async ({ page }) => {
  const state = await fixture(page, { canConfirm: false });
  await page.goto(`/survey/fixture-assignment#certificate_grant=${grant}`);
  await expect(page.getByTestId('survey-attendee-confirmation')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Sign in to use your member details' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Use my member details' })).toHaveCount(0);
  await expect(page.getByRole('main').getByText('First name', { exact: true })).toBeVisible();
  await expect(page.getByRole('main').getByRole('textbox').first()).toHaveValue('Invited attendee');
  expect(state.posts).toEqual([]);
  expect(state.memberReads).toEqual([]);
  expect(state.unexpectedWrites).toEqual([]);
  await page.screenshot({ path: '/tmp/task-4847-logged-out-invitation.jpg', fullPage: true });
});