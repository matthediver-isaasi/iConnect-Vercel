import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { simpleEvent, complexEvent } from './fixtures/task-4629-event-display.fixture.mjs';
import { createLegacySimpleHarness } from './fixtures/ticketReleaseLegacyHandlers.mjs';

const stubs = {
  '@stripe/stripe-js': `export const loadStripe = async () => ({});`,
  '@stripe/react-stripe-js': `
    export const Elements = ({ children }) => children;
    export const PaymentElement = () => null;
    export const useElements = () => ({});
    export const useStripe = () => ({ confirmPayment: async () => ({}) });`,
  '@/api/base44Client': `
    const empty = async () => [];
    export const base44 = {
      entities: new Proxy({}, { get: () => ({ list: empty, filter: empty, get: async () => null }) }),
      functions: { invoke: async (name, payload) => {
        if (name === 'checkDuplicateRegistrations') return { data: { success: true, hasDuplicates: false } };
        if (name === 'getStripePublishableKey' && window.fixture.member) return { data: { publishableKey: 'pk_test_fixture' } };
        window.fixture.calls.push({ name, payload });
        if (window.fixture.backendEnabled && ['createStripePaymentIntent', 'createOneOffEventBooking'].includes(name)) {
          return window.legacyBackendInvoke(name, payload);
        }
        return { data: { success: false, available: false } };
      } },
    };`,
  '@/api/publicClient': `
    export const publicClient = {
      getComplexEvent: async () => structuredClone(window.fixture.event),
      getComplexEventSessions: async () => [],
      createComplexEventPaymentIntent: async payload => {
        window.fixture.calls.push({ name: 'complexPaymentIntent', payload });
        return { error: 'Fixture records requests without calling a payment provider' };
      },
      listSpeakers: async () => [],
      listSystemSettings: async () => [],
      getSystemSetting: async () => null,
      getEventSponsors: async () => ({ sponsors: [], categories: [], assignments: [] }),
      getEventAllocationContext: async () => window.fixture.allocation ? {
        id: 'allocation-fixture', event_id: window.fixture.event.id, ticket_class_id: 'future',
        delegate_email: 'allocated@example.invalid', delegate_first_name: 'Allocated',
        delegate_last_name: 'Attendee', purchased: 1,
      } : null,
      checkMemberEmail: async () => ({ is_member: false }),
    };`,
  '@/api/supabaseClient': `
    const chain = new Proxy({}, { get: (_, key) => key === 'then' ? resolve => resolve({ data: [], error: null }) : () => chain });
    export const isSupabaseConfigured = false;
    export const supabase = { from: () => chain, channel: () => chain, removeChannel: () => {} };`,
  '@/hooks/useEventsData': `
    import { useQuery } from '@tanstack/react-query';
    export const useEventData = id => useQuery({ queryKey: ['fixture-event', id], queryFn: async () => structuredClone(window.fixture.event) });
    export const useEventDataBySlug = () => ({ data: null, isLoading: false });
    export const useMyGroupIds = () => ({ data: [], isFetched: true });`,
  '@/hooks/useMemberAccess': `
    export const useMemberAccess = () => ({
      memberInfo: window.fixture.member || null, organizationInfo: null, memberRole: null, authResolved: true,
      isAdmin: false, isFeatureExcluded: () => false, reloadMemberInfo: async () => {},
      refreshOrganizationInfo: async () => {},
    });`,
  '@/hooks/useSpeakerModuleName': `export const useSpeakerModuleName = () => ({ singular: 'Speaker', plural: 'Speakers' });`,
  '@/hooks/useEventSeatRealtime': `export const useEventSeatRealtime = () => ({ isConnected: false });`,
  '@/hooks/useBalancesRealtime': `export const useBalancesRealtime = () => ({ isConnected: false });`,
  '@/hooks/useTicketAvailabilityRealtime': `export const useTicketAvailabilityRealtime = () => ({ ticketClassAvailability: {}, getTicketClassAvailability: () => null });`,
  '@/hooks/useComplexEventTicketAvailabilityRealtime': `export const useComplexEventTicketAvailabilityRealtime = () => ({ getTicketClassAvailability: () => null });`,
};
for (const name of ['ColleagueSelector', 'AttendeeOptionsSelector', 'BookmarkButton', 'PageTour', 'TourButton']) {
  stubs[name] = `export default function Empty() { return null; }`;
}

function resolve(base) {
  return [base, ...['.jsx', '.js', '.mjs', '.ts', '.tsx', '/index.ts', '/index.js'].map(ext => base + ext)]
    .find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) || base;
}

let script;
test.beforeAll(async () => {
  const bundle = await build({
    stdin: { resolveDir: process.cwd(), loader: 'jsx', contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { BrowserRouter } from 'react-router-dom';
      import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
      import { EventDetailsExperience } from './client/src/pages/EventDetails.jsx';
      import { ComplexEventDetailExperience } from './client/src/pages/ComplexEventDetail.jsx';
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      window.fixture.refresh = () => client.invalidateQueries();
      const Experience = window.fixture.complex ? ComplexEventDetailExperience : EventDetailsExperience;
      createRoot(document.getElementById('root')).render(
        <QueryClientProvider client={client}><BrowserRouter>
          <Experience eventId={window.fixture.event.id} embedded={window.fixture.embedded} allocationToken={window.fixture.allocation ? 'fixture-token' : null} />
        </BrowserRouter></QueryClientProvider>
      );` },
    bundle: true, write: false, jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"test"', 'import.meta.env.DEV': 'false' },
    plugins: [{
      name: 'isolated-ticket-release-fixtures',
      setup(api) {
        api.onResolve({ filter: /.*/ }, args => {
          const name = args.path.split('/').pop();
          if (stubs[args.path] || stubs[name]) return { path: stubs[args.path] ? args.path : name, namespace: 'fixture' };
          if (args.path.startsWith('@/')) return { path: resolve(path.resolve('client/src', args.path.slice(2))) };
          if (args.path.startsWith('@shared/')) return { path: resolve(path.resolve('shared', args.path.slice(8))) };
        });
        api.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: stubs[args.path], loader: 'jsx', resolveDir: process.cwd() }));
        api.onLoad({ filter: /\.css$/ }, () => ({ contents: '', loader: 'css' }));
      },
    }],
  });
  script = bundle.outputFiles[0].text;
});

const start = Date.parse('2026-06-01T09:00:00Z');
const upcoming = {
  id: 'future', name: 'Future ticket', price: 25, visibility_mode: 'members_and_public',
  is_unlimited_tickets: true, release_at: '2026-06-01T09:01:00Z', release_timezone: 'Europe/London',
};
const available = { ...upcoming, id: 'available', name: 'Available ticket', release_at: null, release_timezone: null };
const message = 'Tickets available from 1 June 2026 at 10:01 (Europe/London)';

async function mount(page, {
  complex = false, embedded = false, tickets = [upcoming], allocation = false,
  legacy = null, price = 0, backendEnabled = false,
} = {}) {
  const event = (complex ? complexEvent : simpleEvent)('release-fixture', 'hidden', 'hidden');
  event.start_date = '2099-06-01T09:00:00Z';
  event.end_date = '2099-06-01T10:00:00Z';
  event.event_type = 'one_off';
  event.speaker_ids = [];
  event.pricing_config = { ticket_classes: tickets };
  if (legacy === 'default') event.pricing_config = { ticket_price: price };
  if (legacy === 'absent') {
    delete event.pricing_config;
    event.ticket_price = price;
  }
  const member = legacy ? {
    id: 'legacy-member', email: 'legacy@example.invalid', first_name: 'Legacy', last_name: 'Member',
  } : null;
  await page.route('**/*', route => route.request().url().startsWith('http://ticket-release.fixture/')
    ? route.fulfill({ contentType: 'text/html', body: '<html><body><div id="root"></div></body></html>' })
    : route.abort());
  await page.goto('http://ticket-release.fixture/registration');
  await page.clock.install({ time: start });
  await page.evaluate(config => {
    window.fixture = { ...config, calls: [] };
    if (config.member) sessionStorage.setItem('event_registration_' + config.event.id, JSON.stringify({
      memberAttending: true,
      attendees: [{ ...config.member, isSelf: true, isValid: true }],
    }));
    window.fetch = async (_url, options = {}) => {
      if ((options.method || 'GET') !== 'GET') throw new Error('Fixture rejects all network writes');
      return new Response('[]', { headers: { 'Content-Type': 'application/json' } });
    };
  }, { event, complex, embedded, allocation, member, backendEnabled });
  await page.addScriptTag({ content: script });
}

for (const embedded of [false, true]) {
  test(`simple single ticket retains price, blocks checkout and releases on time (${embedded ? 'Canvas experience' : 'standalone'})`, async ({ page }) => {
    await mount(page, { embedded });
    await expect(page.getByTestId('ticket-release-single')).toHaveText(message);
    await expect(page.getByTestId('ticket-release-single').locator('../../..')).toContainText('25.00');
    await expect(page.locator('#confirm-booking-button')).toBeDisabled();
    await page.clock.fastForward(60_000);
    await expect(page.getByTestId('ticket-release-single')).toHaveCount(0);
    await expect(page.getByTestId('checkout-ticket-release-future')).toHaveCount(0);
  });

  test(`complex add attendee blocks until release (${embedded ? 'Canvas experience' : 'standalone'})`, async ({ page }) => {
    await mount(page, { complex: true, embedded });
    await expect(page.getByTestId('ticket-class-future')).toContainText(message);
    await expect(page.getByTestId('ticket-class-future')).toContainText('25.00');
    await expect(page.getByTestId('button-add-attendee-future')).toBeDisabled();
    await page.clock.fastForward(60_000);
    await expect(page.getByTestId('button-add-attendee-future')).toBeEnabled();
  });
}

test('simple mixed tickets cannot select upcoming card; changed settings clear selection', async ({ page }) => {
  await mount(page, { tickets: [available, upcoming] });
  await expect(page.locator('#ticket-available')).toHaveAttribute('data-state', 'checked');
  await page.getByTestId('ticket-class-future').click();
  await expect(page.locator('#ticket-available')).toHaveAttribute('data-state', 'checked');
  await page.evaluate(() => {
    window.fixture.event.pricing_config.ticket_classes[0].release_at = '2026-06-01T10:00:00Z';
    window.fixture.event.pricing_config.ticket_classes[0].release_timezone = 'Europe/London';
    return window.fixture.refresh();
  });
  await expect(page.locator('[role="radio"][data-state="checked"]')).toHaveCount(0);
  await expect(page.locator('#confirm-booking-button')).toBeDisabled();
});

test('complex settings update closes an open attendee drawer and prevents stale additions', async ({ page }) => {
  await mount(page, { complex: true, tickets: [available] });
  await page.getByTestId('button-add-attendee-available').click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.evaluate(() => {
    Object.assign(window.fixture.event.pricing_config.ticket_classes[0], {
      release_at: '2026-06-01T10:00:00Z', release_timezone: 'Europe/London',
    });
    return window.fixture.refresh();
  });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByTestId('button-add-attendee-available')).toBeDisabled();
  await expect(page.getByTestId('cart-summary')).toHaveCount(0);
});

test('complex changed release clears an existing cart and removes checkout', async ({ page }) => {
  await mount(page, { complex: true, tickets: [{ ...available, price: 0 }] });
  await page.getByTestId('button-add-attendee-available').click();
  await page.getByTestId('input-external-first-name').fill('Fixture');
  await page.getByTestId('input-external-last-name').fill('Attendee');
  await page.getByTestId('input-external-email').fill('fixture@example.invalid');
  await page.getByTestId('button-add-external').click();
  await expect(page.getByTestId('cart-summary')).toContainText('fixture@example.invalid');
  await expect(page.locator('#confirm-booking-button')).toBeEnabled();
  await page.evaluate(() => {
    Object.assign(window.fixture.event.pricing_config.ticket_classes[0], {
      release_at: '2026-06-01T10:00:00Z', release_timezone: 'Europe/London',
    });
    return window.fixture.refresh();
  });
  await expect(page.getByTestId('cart-summary')).toHaveCount(0);
  await expect(page.locator('#confirm-booking-button')).toHaveCount(0);
  await expect(page.getByTestId('button-add-attendee-available')).toBeDisabled();
});

test('complex guest payment intent forwards purchaser email through the adapter', async ({ page }) => {
  await mount(page, { complex: true, tickets: [available] });
  await page.getByTestId('button-add-attendee-available').click();
  await page.getByTestId('input-external-first-name').fill('Fixture');
  await page.getByTestId('input-external-last-name').fill('Attendee');
  await page.getByTestId('input-external-email').fill('fixture@example.invalid');
  await page.getByTestId('button-add-external').click();
  await page.locator('#confirm-booking-button').click();
  await expect.poll(() => page.evaluate(() => window.fixture.calls.find(call => call.name === 'complexPaymentIntent')?.payload.purchaser_email)).toBe('fixture@example.invalid');
});

test('simple Stripe metadata includes stable selected ticket id', async ({ page }) => {
  await mount(page, { tickets: [available] });
  await page.locator('#guest-first-name').fill('Fixture');
  await page.locator('#guest-last-name').fill('Attendee');
  await page.locator('#guest-email').fill('fixture@example.invalid');
  await page.getByTestId('input-guest-organization').fill('Fixture Organisation');
  await page.locator('#confirm-booking-button').click();
  await expect.poll(() => page.evaluate(() => window.fixture.calls.find(call => call.name === 'createStripePaymentIntent')?.payload.metadata.ticket_class_id)).toBe('available');
});

for (const legacy of ['default', 'absent']) {
  for (const price of [0, 25]) {
    test(`legacy ${legacy} ${price ? 'paid' : 'free'} browser payload reaches real booking handlers`, async ({ page }) => {
      await mount(page, { legacy, price, backendEnabled: true });
      const event = await page.evaluate(() => window.fixture.event);
      const harness = createLegacySimpleHarness({ event });
      const member = await page.evaluate(() => window.fixture.member);
      harness.rows.member.push({ ...member, tenant_id: 'tenant-a' });
      const results = [];
      await page.exposeFunction('legacyBackendInvoke', async (name, body) => {
        const result = await harness.invoke(name, body);
        results.push({ name, body, status: result.res.statusCode, response: result.response });
        return { data: result.response };
      });
      await expect(page.locator('#confirm-booking-button')).toBeEnabled();
      if (price) {
        await page.locator('#card').click();
        await page.locator('#confirm-booking-button').click();
        await expect.poll(() => results.length).toBe(1);
        expect(results[0].status).toBe(200);
        expect(results[0].response.success).toBe(true);
        expect(results[0].body.metadata.ticket_class_id).toBe(legacy === 'default' ? 'default' : null);
        expect(results[0].body.amount).toBe(price);
        await page.getByRole('button', { name: 'Pay £25.00', exact: true }).click();
      } else {
        await page.locator('#confirm-booking-button').click();
      }
      await expect.poll(() => results.some(result => result.name === 'createOneOffEventBooking')).toBe(true);
      const booking = results.find(result => result.name === 'createOneOffEventBooking');
      expect(booking.status).toBe(200);
      expect(booking.response.success, JSON.stringify(booking.response)).toBe(true);
      expect(booking.body.ticketClassId).toBe(legacy === 'default' ? 'default' : null);
      expect(booking.body.totalCost).toBe(price);
      expect(harness.rows.booking).toHaveLength(1);
      expect(harness.unexpected).toEqual([]);
      expect(harness.calls.filter(call => call.rpc?.includes('ticket_class'))).toEqual([]);
      expect(harness.paymentIntents.size).toBe(price ? 1 : 0);
      await test.info().attach(`legacy-${legacy}-${price}-real-handler.json`, {
        body: JSON.stringify({ event, results, bookings: harness.rows.booking, calls: harness.calls }, null, 2),
        contentType: 'application/json',
      });
    });
  }
}

test('release never overrides sold-out or members-only restrictions', async ({ page }) => {
  await mount(page, { complex: true, tickets: [
    { ...upcoming, is_unlimited_tickets: false, available_count: 0, is_sold_out: true },
    { ...available, id: 'private', visibility_mode: 'members_only' },
  ] });
  await page.clock.fastForward(60_000);
  await expect(page.getByTestId('button-add-attendee-future')).toBeDisabled();
  await expect(page.getByTestId('ticket-class-private')).toHaveCount(0);
});

for (const complex of [false, true]) {
  test(`already purchased ${complex ? 'complex' : 'simple'} allocation is not gated by release`, async ({ page }) => {
    await mount(page, { complex, allocation: true });
    await expect(page.getByTestId('allocation-context')).toBeVisible();
    await expect(page.getByText(message, { exact: true })).toHaveCount(0);
    await expect(page.getByTestId('checkout-ticket-release-future')).toHaveCount(0);
    if (complex) await expect(page.getByTestId('cart-summary')).toContainText('allocated@example.invalid');
    await expect(page.locator('#confirm-booking-button')).toBeEnabled();
  });
}

test('Canvas registration wrapper delegates to the same release-aware experiences', () => {
  const source = fs.readFileSync('client/src/components/canvas/blocks/dynamicBlocks.jsx', 'utf8');
  expect(source).toContain('default: module.EventDetailsExperience');
  expect(source).toContain('default: module.ComplexEventDetailExperience');
  expect(source).toContain('simpleExperience: SimpleExperience = EventDetailsExperience');
  expect(source).toContain('complexExperience: ComplexExperience = ComplexEventDetailExperience');
});