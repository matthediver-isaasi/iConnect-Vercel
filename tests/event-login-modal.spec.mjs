import { test, expect } from '@playwright/test';

const member = { id: 'modal-member', tenant_id: 'modal-tenant', role_id: 'modal-role', email: 'member@example.invalid', first_name: 'Modal', last_name: 'Member', organization_id: null, page_tours_seen: { EventDetails: true } };
const role = { id: member.role_id, tenant_id: member.tenant_id, excluded_features: [], show_tours: false, default_landing_page: 'Preferences' };
const ticket = { id: 'member-ticket', name: 'Member ticket', price: 20, visibility_mode: 'members_only', role_match_only: true, role_ids: [role.id], member_group_ids: [], is_unlimited_tickets: true, all_tracks: true };

async function fixture(page, { complex = false, multiple = false, slug = false, embedded = false, canvas = false } = {}) {
  const state = { signedIn: false, reject: false, failSession: false, restricted: false, delay: 0, logins: 0, sessions: 0, documents: 0 };
  const event = {
    id: 'modal-event', slug: 'modal-event', title: 'Modal fixture event', description: '<p>Stay on this event</p>',
    status: 'published', event_state: 'active', type: 'one_off', start_date: '2027-06-10T09:00:00Z', end_date: '2027-06-10T17:00:00Z',
    timezone: 'Europe/London', is_unlimited_registration: true, available_seats: null, tracks: [], speaker_ids: [],
    pricing_config: { allowGuestsToViewAllTickets: true, ticket_classes: multiple ? [ticket, { ...ticket, id: 'public-ticket', name: 'Public ticket', visibility_mode: 'members_and_public', role_match_only: false, role_ids: [] }] : [ticket] },
  };
  await page.context().route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== new URL(test.info().project.use.baseURL).origin) return route.abort();
    if (request.resourceType() === 'document') state.documents++;
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/api/auth/login' || url.pathname === '/api/auth/set-password') {
      state.logins++;
      if (state.disabled) return json({ success: false, error: 'Login is disabled for this account.' }, 403);
      if (state.reject) return json({ success: false, error: 'Invalid email or password' }, 401);
      if (state.passwordSetup && url.pathname.endsWith('/login')) return json({ needsPasswordSetup: true });
      state.signedIn = true;
      return json({ success: true, member });
    }
    if (url.pathname === '/api/auth/me') {
      state.sessions++;
      if (state.signedIn && state.delay) await new Promise(resolve => setTimeout(resolve, state.delay));
      if (!state.signedIn || state.failSession) return json({ error: 'Not authenticated' }, 401);
      const current = state.restricted ? { ...member, role_id: 'other-role' } : member;
      return json({ ...current, sessionRole: { status: 'ready', member_id: current.id, tenant_id: current.tenant_id, role_id: current.role_id, role: { ...role, id: current.role_id } } });
    }
    if (url.pathname === '/api/public/page/modal-canvas') return json({ success: true, elements: [], symbols: [], page: {
      id: 'modal-canvas', slug: 'modal-canvas', title: 'Canvas event', status: 'published', builder_type: 'canvas',
      layout_type: 'public', access_level: 'public', public_chrome: 'both',
      canvas_design: { version: 1, canvas: { width: 1200, height: 1900 }, root: { sections: [{
        id: 'event-section', type: 'section', style: { minHeight: 1900 }, children: [{
          id: 'event-block', type: 'event-registration', position: { x: 20, y: 20 }, size: { width: 1100, height: 1800 },
          style: {}, content: { eventType: complex ? 'complex' : 'simple', eventId: event.id },
        }],
      }] } },
    } });
    if (url.pathname === '/api/auth/tenant-public-settings') return json({ success: true, settings: { member_google_login_enabled: true } });
    if (url.pathname === '/api/auth/request-password-reset') return json({ success: true });
    if (url.pathname === '/api/public/tenant-branding') return json({ success: true, branding: { id: member.tenant_id, name: 'Modal fixture', headerConfig: {}, footerConfig: {}, platformBranding: { enabled: false } } });
    if (url.pathname === '/api/public/portal-branding') return json({ tenantName: 'Modal fixture' });
    if (url.pathname === '/api/public/event' || url.pathname === '/api/public/complex-event' || url.pathname === '/api/entities/Event/modal-event') return json(event);
    if (url.pathname === '/api/entities/Event') return json([event]);
    if (url.pathname.startsWith('/api/entities/Role/')) return json(role);
    if (url.pathname === '/api/member-group-events/my-groups') return json({ groupIds: [] });
    if (url.pathname.includes('/unread-count')) return json({ unreadCount: 0 });
    if (url.pathname === '/api/public/page/login' && state.canvasLogin) return json({
      success: true, page: { id: 'canvas-login', slug: 'login', status: 'published', builder_type: 'canvas', canvas_design: {
        version: 2, root: { sections: [{ id: 'section-login', type: 'section', style: { minHeight: 600 }, children: [
          { id: 'login-block', type: 'login-form', position: { x: 0, y: 0 }, size: { width: 500, height: 550 }, style: {}, content: {} },
        ] }] },
      } },
    });
    if (url.pathname.includes('/page/')) return json({ success: true, page: null });
    return json([]);
  });
  const path = canvas ? '/modal-canvas' : embedded ? `/${complex ? 'ComplexEventDetail' : 'EventDetails'}?id=modal-event&embed=true`
    : complex ? (slug ? '/session-events/modal-event' : '/ComplexEventDetail?id=modal-event')
      : slug ? '/events/modal-event' : '/EventDetails?id=modal-event';
  await page.goto(`${path}${path.includes('?') ? '&' : '?'}campaign=keep&mode=set-password&token=unrelated#tickets`);
  await expect(page.getByText('Modal fixture event', { exact: true }).first()).toBeVisible();
  return state;
}

async function signIn(page) {
  await page.getByTestId('input-email').fill(member.email);
  await page.getByTestId('input-password').fill('fixture-password');
  await page.getByTestId('button-login').click();
}

for (const options of [{}, { multiple: true }, { complex: true }, { slug: true }, { complex: true, slug: true }, { embedded: true }, { complex: true, embedded: true }, { canvas: true, multiple: true }, { canvas: true, complex: true }]) {
  test(`in-place login, focus and cancellation ${JSON.stringify(options)}`, async ({ page }) => {
    const state = await fixture(page, options);
    const url = page.url();
    if (options.multiple) {
      await page.getByTestId('ticket-class-public-ticket').click();
      await expect(page.getByTestId('ticket-class-public-ticket').getByRole('radio')).toBeChecked();
    }
    const trigger = page.getByTestId(options.complex ? 'button-login-to-register' : options.multiple ? 'link-login-ticket-member-ticket' : 'link-login-ticket-single');
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: 'Sign in to book tickets' });
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('input-password')).toBeVisible(); // unrelated mode/token ignored
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    await trigger.click();
    await expect.poll(() => page.evaluate(() => document.body.getAttribute('data-scroll-locked'))).not.toBeNull();
    for (let i = 0; i < 12; i++) await page.keyboard.press('Tab');
    expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true);
    await page.mouse.click(2, 2);
    await expect(dialog).toBeVisible();
    state.reject = true;
    await signIn(page);
    await expect(page.getByRole('alert')).toContainText('Invalid email or password');
    state.reject = false;
    state.delay = 700;
    const documents = state.documents;
    await signIn(page);
    await expect(dialog).toBeVisible();
    await expect(dialog).toBeHidden({ timeout: 25000 });
    await expect(page.getByText('Modal fixture event', { exact: true }).first()).toBeVisible();
    expect(page.url()).toBe(url);
    expect(state.documents).toBe(documents);
    expect(state.sessions).toBeGreaterThan(1);
    await expect(trigger).toBeHidden();
    if (options.multiple) await expect(page.getByTestId('ticket-class-public-ticket').getByRole('radio')).toBeChecked();
  });
}

test('session failure can be retried; ineligible member stays restricted', async ({ page }) => {
  const state = await fixture(page, { complex: true });
  await page.getByTestId('button-login-to-register').click();
  state.failSession = true;
  await signIn(page);
  await expect(page.getByRole('alert')).toContainText('session could not be refreshed', { timeout: 25000 });
  state.failSession = false;
  state.restricted = true;
  await signIn(page);
  await expect(page.getByRole('dialog', { name: 'Sign in to book tickets' })).toBeHidden({ timeout: 25000 });
  await expect(page.getByTestId('booking-section')).not.toContainText('Member ticket');
});

test('disabled accounts and stale local storage never enable tickets', async ({ page }) => {
  await page.addInitScript(member => localStorage.setItem('agcas_member', JSON.stringify(member)), member);
  const state = await fixture(page);
  await page.getByTestId('link-login-ticket-single').click();
  state.disabled = true;
  await signIn(page);
  await expect(page.getByRole('alert')).toContainText('Login is disabled');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('link-login-ticket-single')).toBeVisible();
});

for (const canvas of [false, true]) {
  test(`ordinary ${canvas ? 'Canvas' : 'standalone'} login still redirects`, async ({ page }) => {
    const state = await fixture(page);
    state.canvasLogin = canvas;
    await page.goto('/login?returnTo=' + encodeURIComponent('/EventDetails?id=modal-event#return-here'));
    await signIn(page);
    await expect(page).toHaveURL(/EventDetails\?id=modal-event#return-here/);
    await expect(page.getByText('Modal fixture event', { exact: true }).first()).toBeVisible();
  });
}

test('password setup and recovery stay in the event', async ({ page }) => {
  const state = await fixture(page);
  const url = page.url();
  await page.getByTestId('link-login-ticket-single').click();
  await page.getByTestId('link-forgot-password').click();
  await page.getByTestId('input-email-reset').fill(member.email);
  await page.getByTestId('button-send-reset').click();
  await expect(page.getByText('Reset link sent!')).toBeVisible();
  await page.getByTestId('button-back-to-login').click();
  state.passwordSetup = true;
  await signIn(page);
  await page.getByTestId('input-new-password').fill('new-fixture-password');
  await page.getByTestId('input-confirm-password').fill('new-fixture-password');
  await page.getByTestId('button-set-password').click();
  await expect(page.getByRole('dialog', { name: 'Sign in to book tickets' })).toBeHidden({ timeout: 25000 });
  expect(page.url()).toBe(url);
});

test('Google retains exact safe event return destination', async ({ page }) => {
  await fixture(page);
  const path = new URL(page.url());
  await page.getByTestId('link-login-ticket-single').click();
  const destination = page.waitForRequest('**/api/auth/google?*');
  await page.getByTestId('button-google-login').click();
  expect(new URL((await destination).url()).searchParams.get('returnTo')).toBe(path.pathname + path.search + path.hash);
});