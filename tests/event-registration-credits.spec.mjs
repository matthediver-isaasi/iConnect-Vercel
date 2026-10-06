import { expect, test } from '@playwright/test';
import { projectCredits } from '../api/reports/_credits.js';

// Isolated browser fixtures, not an authenticated GFI deployment test.
const tenant = { id: 'credit-tenant', name: 'Local credits fixture', slug: 'local-credits' };
const role = { id: 'credit-role', name: 'Administrator', excluded_features: [] };
const user = {
  id: 'credit-admin', email: 'credits@example.invalid', first_name: 'Credits',
  tenant_id: tenant.id, organization_id: null, role_id: role.id,
  member_excluded_features: [], is_team_member: true,
  sessionRole: { status: 'ready', member_id: 'credit-admin', tenant_id: tenant.id, role_id: role.id, role },
};
const event = { id: 'credit-event', title: 'GFI Annual Conference 2026: Unpacked (isolated fixture)', start_date: '2026-11-10T09:00:00Z', is_complex: false };
function group(i, credits) {
  return {
    groupRef: null, isGroup: false, attendeeCount: 1, eventTitle: event.title, eventId: event.id,
    isComplexEvent: false, bookingSource: 'booking', eventStartDate: event.start_date, credits,
    groupPayment: { ticketTotal: 100, totalCost: 100, totalAfterDiscount: 100, discount: 0,
      offerDiscount: 0, codeDiscount: 0, voucherAmount: 0, trainingFundAmount: 0, accountAmount: 0, paymentMethod: 'account' },
    attendees: [{ id: `local-${i}`, attendee_first_name: i === 0 ? 'Positive' : 'Zero', attendee_last_name: `Credit ${i}`,
      attendee_email: `local-${i}@example.invalid`, ticket_class_name: 'Conference', ticket_price: 100,
      ticket_price_status: 'available', price_paid: 100, price_paid_status: 'net', payment_method: 'account',
      booking_reference: `LOCAL-${i}`, status: 'confirmed', created_at: '2026-09-01T12:00:00Z', badge: true }],
  };
}

async function fixture(page, groups) {
  const state = { discovery: [], writes: [], reportReads: 0 };
  await page.addInitScript(() => {
    localStorage.clear(); sessionStorage.clear();
    URL.parse ??= (value, base) => { try { return new URL(value, base); } catch { return null; } };
  });
  await page.context().routeWebSocket('**/realtime/v1/websocket*', socket => socket.onMessage(() => {}));
  await page.context().route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.hostname.endsWith('.supabase.co')) return json([]);
    if (['fonts.googleapis.com', 'fonts.gstatic.com', 'cdnjs.cloudflare.com', 'js.stripe.com', 'va.vercel-scripts.com', 'teeone.pythonanywhere.com'].includes(url.hostname)) return route.fulfill({ status: 204, body: '' });
    if (!path.startsWith('/api/')) return route.continue();
    if (/reconcile-booking-credits|stripe|xero|quickbooks/.test(path)) {
      state.discovery.push(path); return json({}, 599);
    }
    if (request.method() === 'PATCH' && path === `/api/entities/Member/${user.id}`) return json(user);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) { state.writes.push(path); return json({}, 599); }
    if (path === '/api/auth/me') return json(user);
    if (path === '/api/auth/tenant-user-me') return json({ authenticated: false }, 401);
    if (path === '/api/reports/event-registration-report') {
      if (!new URL(request.url()).searchParams.has('generate')) return json({ events: [event] });
      state.reportReads++;
      return json({ tenantId: tenant.id, events: [event], bookingGroups: groups, organizations: {}, summary: {} });
    }
    if (path.startsWith('/api/entities/Role/')) return json(role);
    if (path === '/api/entities/Role') return json([role]);
    if (path === '/api/entities/Member') return json([user]);
    if (path.startsWith('/api/entities/Member/')) return json(user);
    if (path === '/api/custom-objects') return json({ objects: [], total: 0 });
    if (path === '/api/communication/inbox/unread-count') return json({ unreadCount: 0 });
    if (path === '/api/public/ai-help-persona') return json({ enabled: false });
    if (path === '/api/tenant-canvas-theme') return json({ theme: null });
    if (path === '/api/public/canvas-symbols') return json({ symbols: [] });
    if (path.startsWith('/api/redirects/resolve')) return json({ found: false });
    return json([]);
  });
  await page.goto('/EventRegistrationReport');
  await page.getByTestId('button-generate-report').click();
  await expect(page.getByTestId('row-booking-local-0')).toBeVisible();
  return state;
}

async function exportCredits(page) {
  await page.getByTestId('button-export-csv').click();
  await page.getByTestId('button-clear-all-columns').click();
  await page.getByTestId('checkbox-column-std:name').click();
  await page.getByTestId('checkbox-column-std:credits').click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('button-confirm-export').click();
  const stream = await (await downloadPromise).createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

test('local nonzero and zero survive reload, filtering and export without discovery', async ({ page }) => {
  const positive = projectCredits([{ operation_key: 'note', provider: 'xero', provider_id: 'cn_local',
    leg: 'credit_note', status: 'confirmed', amount_minor: 6000, currency: 'GBP' }]);
  const groups = [group(0, positive), ...Array.from({ length: 27 }, (_, i) => group(i + 1, projectCredits([])))];
  const state = await fixture(page, groups);
  await expect(page.getByTestId('text-credits-local-0')).toHaveText('£60.00');
  await expect(page.getByTestId('text-credits-local-1')).toHaveText('£0.00');
  await expect(page.getByTestId('text-total-credits')).toContainText('Recorded credits: £60.00');
  await expect(page.getByTestId('text-total-revenue')).toHaveText('£2740.00');
  await expect(page.getByTestId('button-refresh-booking-credits')).toHaveCount(0);
  const csv = await exportCredits(page);
  expect(csv).toContain('£60.00');
  expect(csv).toContain('No credits recorded in iConnect');
  expect(csv).not.toMatch(/checked|verified|coverage/i);
  await page.reload();
  if (await page.getByTestId('row-booking-local-0').count() === 0) await page.getByTestId('button-generate-report').click();
  await expect(page.getByTestId('text-credits-local-0')).toHaveText('£60.00');
  await page.getByTestId('input-search').fill('Positive');
  await expect(page.getByTestId('text-total-credits')).toContainText('£60.00');
  await expect(page.getByTestId('text-total-revenue')).toHaveText('£40.00');
  const filtered = await exportCredits(page);
  expect(filtered).toContain('£60.00');
  expect(filtered).not.toContain('No credits recorded');
  expect(state.reportReads).toBeGreaterThanOrEqual(2);
  expect(state.discovery).toEqual([]);
  expect(state.writes).toEqual([]);
});

test('legacy reference without amount is explicit in the table and CSV', async ({ page }) => {
  const state = await fixture(page, [group(0, projectCredits([], { historicalUnknown: true }))]);
  await expect(page.getByTestId('text-credits-local-0')).toHaveText('Amount not recorded');
  await expect(page.getByTestId('text-total-revenue')).toHaveText('Unavailable');
  expect(await exportCredits(page)).toContain('Amount not recorded');
  expect(state.discovery).toEqual([]);
});
