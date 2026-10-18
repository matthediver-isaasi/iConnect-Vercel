import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { simpleEvent, complexEvent } from '../../../../tests/fixtures/task-4629-event-display.fixture.mjs';

const memberId = '44444444-4444-4444-8444-444444444444';
const eventId = '22222222-2222-4222-8222-222222222222';
const groupId = '33333333-3333-4333-8333-333333333333';
const privateTicket = { id: 'private', name: 'Private invitation', price: 0, is_free: true, audience_mode: 'selected_members', private_ticket_eligible: true, visibility_mode: 'members_only', is_unlimited_tickets: true, all_tracks: true };
const sibling = { id: 'sibling', name: 'Independent public ticket', price: 0, is_free: true, visibility_mode: 'members_and_public', is_unlimited_tickets: true, all_tracks: true };
const member = { id: memberId, tenant_id: 'fixture-tenant', email: 'member@example.invalid', first_name: 'Fixture', last_name: 'Member' };

const stubs = {
  '@/components/auth/useEventLogin': `export const useEventLogin = () => ({ openLogin: () => {}, loginModal: null });`,
  '@stripe/stripe-js': `export const loadStripe = async () => ({});`,
  '@stripe/react-stripe-js': `export const Elements = ({children}) => children; export const PaymentElement = () => null; export const useElements = () => ({}); export const useStripe = () => ({});`,
  '@/api/base44Client': `
    export const getActiveTenantId = () => 'fixture-tenant';
    export const subscribeToActiveTenantId = () => () => {};
    const empty = async () => [];
    export const base44 = {
      entities: new Proxy({}, { get: (_, name) => ({
        list: async () => name === 'ComplexEventTicketClass' && window.fixture.actualEditor ? window.fixture.event.pricing_config.ticket_classes : [],
        filter: empty,
        get: async () => ['Event', 'ComplexEvent'].includes(name) && window.fixture.actualEditor ? window.fixture.event : null,
        create: async data => (await fetch('/fixture/entities/' + name, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })).json(),
        update: async (id, data) => (await fetch('/fixture/entities/' + name, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...data, id }) })).json(),
        delete: async id => (await fetch('/fixture/entities/' + name, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) })).json(),
      }) }),
      functions: { invoke: async name => {
        if (name === 'checkDuplicateRegistrations') return { data: { success: true, hasDuplicates: false } };
        return { data: { success: false, available: false } };
      } },
    };`,
  '@/api/publicClient': `
    export const publicClient = {
      getComplexEvent: async () => (await fetch('/fixture/event')).json(),
      getComplexEventSessions: async () => (await fetch('/fixture/sessions')).json(),
      listSpeakers: async () => [], listSystemSettings: async () => [],
      getSystemSetting: async () => null,
      getEventSponsors: async () => ({ sponsors: [], categories: [], assignments: [] }),
      checkMemberEmail: async () => ({ is_member: false }),
      getEventAllocationContext: async () => window.fixture.allocation ? {
        event_id: window.fixture.event.id, ticket_class_id: 'private', purchased: 1,
        delegate_email: 'allocated@example.invalid', delegate_first_name: 'Allocated', delegate_last_name: 'Guest',
        ticket_class: window.fixture.allocationTicket,
      } : null,
    };`,
  '@/api/supabaseClient': `
    const chain = new Proxy({}, { get: (_, key) => key === 'then' ? resolve => resolve({ data: [], error: null }) : () => chain });
    export const isSupabaseConfigured = false;
    export const supabase = { from: () => chain, channel: () => chain, removeChannel: () => {} };`,
  '@/hooks/useEventsData': `
    import { useQuery } from '@tanstack/react-query';
    export const useEventData = id => useQuery({
      queryKey: ['fixture-event', id, window.fixture.member?.tenant_id, window.fixture.member?.id],
      queryFn: async () => (await fetch('/fixture/event')).json(),
    });
    export const useEventDataBySlug = () => ({ data: null, isLoading: false });
    export const useMyGroupIds = () => ({ data: [], isFetched: true });`,
  '@/hooks/useMemberAccess': `
    export const useMemberAccess = () => ({
      memberInfo: window.fixture.member, organizationInfo: null, memberRole: null,
      authResolved: true, sessionValidated: true, roleStatus: 'ready', isAdmin: false,
      isAccessReady: true,
      isFeatureExcluded: () => false, reloadMemberInfo: async () => {}, refreshOrganizationInfo: async () => {},
    });`,
  '@/hooks/useSpeakerModuleName': `export const useSpeakerModuleName = () => ({ singular: 'Speaker', plural: 'Speakers' });`,
  '@/hooks/useEventSeatRealtime': `export const useEventSeatRealtime = () => ({ isConnected: false });`,
  '@/hooks/useBalancesRealtime': `export const useBalancesRealtime = () => ({ isConnected: false });`,
  '@/hooks/useTicketAvailabilityRealtime': `export const useTicketAvailabilityRealtime = () => ({ ticketClassAvailability: {}, getTicketClassAvailability: () => null });`,
  '@/hooks/useComplexEventTicketAvailabilityRealtime': `export const useComplexEventTicketAvailabilityRealtime = () => ({ getTicketClassAvailability: () => null });`,
};
for (const name of ['ColleagueSelector', 'AttendeeOptionsSelector', 'BookmarkButton', 'PageTour', 'TourButton']) stubs[name] = `export default function Empty() { return null; }`;

function resolve(base) {
  return [base, ...['.jsx', '.js', '.mjs', '.ts', '.tsx', '/index.ts', '/index.js'].map(ext => base + ext)]
    .find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) || base;
}

let script;
test.beforeAll(async () => {
  const bundle = await build({
    stdin: { resolveDir: process.cwd(), loader: 'jsx', contents: `
      import React, { useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { BrowserRouter } from 'react-router-dom';
      import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
      import { EventDetailsExperience } from './client/src/pages/EventDetails.jsx';
      import { ComplexEventDetailExperience } from './client/src/pages/ComplexEventDetail.jsx';
      import CreateEvent from './client/src/pages/CreateEvent.jsx';
      import EditEvent from './client/src/pages/EditEvent.jsx';
      import CreateComplexEvent from './client/src/pages/CreateComplexEvent.jsx';
      import PublicTicketMemberFields from './client/src/components/events/PublicTicketMemberFields.jsx';
      import { updateTicketMemberField } from './client/src/utils/publicTicketMembers.js';
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      function Fixture() {
        const [, rerender] = useState(0);
        const [ticket, setTicket] = useState(window.fixture.ticket || {});
        window.fixture.session = member => { window.fixture.member = member; rerender(n => n + 1); };
        if (window.fixture.actualEditor) {
          const Editor = window.fixture.complex ? CreateComplexEvent : window.fixture.edit ? EditEvent : CreateEvent;
          return <Editor />;
        }
        const Experience = window.fixture.complex ? ComplexEventDetailExperience : EventDetailsExperience;
        if (!window.fixture.editor) return <Experience eventId={window.fixture.event.id} allocationToken={window.fixture.allocation ? 'verified-fixture-token' : null} />;
        return <>
          <PublicTicketMemberFields ticket={ticket} eventId={window.fixture.edit ? window.fixture.event.id : null}
            eventType={window.fixture.complex ? 'complex' : 'simple'} groupId={window.fixture.groupId}
            onChange={patch => setTicket(previous => ({ ...previous, ...patch }))} />
          <button onClick={() => setTicket(t => updateTicketMemberField(t, 'role_ids', ['role']))}>Choose role audience</button>
          <button onClick={() => setTicket(t => updateTicketMemberField(t, 'visibility_mode', 'public_only'))}>Choose public audience</button>
          <output data-testid="ticket-state">{JSON.stringify(ticket)}</output>
        </>;
      }
      createRoot(document.getElementById('root')).render(
        <QueryClientProvider client={client}><BrowserRouter><Fixture /></BrowserRouter></QueryClientProvider>
      );
    ` },
    bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"test"', 'import.meta.env': '{}' },
    loader: { '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl' },
    plugins: [{
      name: 'isolated-fixture',
      setup(builder) {
        builder.onResolve({ filter: /.*/ }, args => {
          const key = Object.hasOwn(stubs, args.path) ? args.path : Object.keys(stubs).find(name => !name.includes('/') && args.path.endsWith('/' + name));
          if (key) return { path: key, namespace: 'stub' };
          if (args.path.startsWith('@/')) return { path: resolve(path.resolve('client/src', args.path.slice(2))) };
          if (args.path.startsWith('@shared/')) return { path: resolve(path.resolve('shared', args.path.slice(8))) };
        });
        builder.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({ contents: stubs[args.path], loader: 'jsx', resolveDir: process.cwd() }));
      },
    }],
  });
  script = bundle.outputFiles[0].text;
});

async function mount(page, options = {}) {
  const event = (options.complex ? complexEvent : simpleEvent)(eventId, 'hidden', 'hidden');
  Object.assign(event, { start_date: '2099-06-01T09:00:00Z', end_date: '2099-06-01T10:00:00Z', event_type: 'one_off', speaker_ids: [] });
  event.pricing_config = { ticket_classes: options.tickets || [privateTicket, sibling], allow_guests_to_view_all_tickets: true };
  if (options.configured !== undefined) event.pricing_config.ticket_classes_configured = options.configured;
  event.tracks = options.tracks || [];
  const fixture = { event, member: options.signedIn ? member : null, groupId, ...options };
  const searches = [], writes = [];
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://selected-members.fixture') return route.abort();
    if (url.pathname.startsWith('/fixture/entities/') && ['POST', 'PATCH', 'DELETE'].includes(route.request().method())) {
      const entity = url.pathname.split('/').pop();
      const data = route.request().postDataJSON();
      if (route.request().method() !== 'DELETE') writes.push({ entity, data });
      return route.fulfill({ json: { ...data, id: data.id || (entity === 'ComplexEventTicketClass' ? 'saved-ticket' : eventId) } });
    }
    if (url.pathname === '/api/events/check-clashes') return route.fulfill({ json: { hasClashes: false, clashes: [] } });
    if (url.pathname === '/api/public/check-event-slug') return route.fulfill({ json: { available: true } });
    if (route.request().method() !== 'GET') return route.abort();
    if (url.pathname === '/fixture/event') return route.fulfill({ json: event });
    if (url.pathname === '/fixture/sessions') return route.fulfill({ json: options.sessions || [] });
    if (url.pathname === '/api/events/ticket-members') {
      searches.push(url);
      return route.fulfill({ json: { results: [member], selected: url.searchParams.has('ids') ? [member] : [] } });
    }
    if (url.pathname === '/registration') return route.fulfill({ contentType: 'text/html', body: '<html><body><div id="root"></div></body></html>' });
    return route.fulfill({ json: [] });
  });
  await page.goto(`http://selected-members.fixture/registration${options.edit ? '?id=' + eventId : ''}`);
  await page.evaluate(config => { window.fixture = config; }, fixture);
  await page.addScriptTag({ content: script });
  return { event, searches, writes };
}

test('complex account switch removes only the invalid private cart entry', async ({ page }) => {
  const { event } = await mount(page, { complex: true, signedIn: true });
  for (const id of ['private', 'sibling']) {
    await page.getByTestId(`button-add-attendee-${id}`).click();
    await page.getByTestId('tab-external').click();
    await page.getByTestId('input-external-first-name').fill('Fixture');
    await page.getByTestId('input-external-last-name').fill(id);
    await page.getByTestId('input-external-email').fill(`${id}@example.invalid`);
    await page.getByTestId('button-add-external').click();
  }
  await expect(page.getByTestId('cart-summary')).toContainText('private@example.invalid');
  await expect(page.getByTestId('cart-summary')).toContainText('sibling@example.invalid');
  event.pricing_config.ticket_classes = [sibling];
  await page.evaluate(member => window.fixture.session({ ...member, id: 'another-member' }), member);
  await expect(page.getByTestId('cart-summary')).not.toContainText('private@example.invalid');
  await expect(page.getByTestId('cart-summary')).toContainText('sibling@example.invalid');
  await expect(page.getByText('Private invitation', { exact: true })).toHaveCount(0);
});

test('complex tracks associated only with an ineligible private ticket are omitted', async ({ page }) => {
  await mount(page, {
    complex: true,
    tickets: [{ ...privateTicket, all_tracks: false, linked_track_ids: ['private-track'] }, { ...sibling, all_tracks: false, linked_track_ids: ['public-track'] }],
    tracks: [{ id: 'private-track', name: 'Private stream' }, { id: 'public-track', name: 'Public stream' }],
    sessions: [
      { id: 'private-session', title: 'Invitation-only session', start_time: '2099-06-01T09:00:00Z', end_time: '2099-06-01T10:00:00Z', track_names: ['Private stream'], speaker_ids: [] },
      { id: 'public-session', title: 'Independent public session', start_time: '2099-06-01T09:00:00Z', end_time: '2099-06-01T10:00:00Z', track_names: ['Public stream'], speaker_ids: [] },
    ],
  });
  await expect(page.getByText('Independent public session', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Invitation-only session', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Private stream', { exact: true })).toHaveCount(0);
});

for (const complex of [false, true]) {
  test(`${complex ? 'complex' : 'simple'} private purchased allocation renders only the verified fixed entitlement`, async ({ page }) => {
    await mount(page, {
      complex, allocation: true, configured: true,
      allocationTicket: { ...privateTicket, private_ticket_eligible: false, allocation_ticket_eligible: true },
      tickets: [{ ...privateTicket, id: 'other-private', name: 'Unrelated private sibling', private_ticket_eligible: false }],
    });
    await expect(page.getByTestId('allocation-context')).toBeVisible();
    await expect(page.getByText('Unrelated private sibling', { exact: true })).toHaveCount(0);
    if (complex) await expect(page.getByTestId('cart-summary')).toContainText('allocated@example.invalid');
    await expect(page.locator('#confirm-booking-button')).toBeEnabled();
  });

  for (const edit of [false, true]) {
    test(`actual ${complex ? 'complex' : 'simple'} ${edit ? 'edit' : 'create'} editor saves private audience and reopens hydrated members`, async ({ page }) => {
      const { writes } = await mount(page, { actualEditor: true, complex, edit, tickets: [sibling] });
      if (!edit) {
        await page.getByTestId('input-title').fill('Saved audience fixture');
        await page.getByTestId('input-slug').fill('saved-audience-fixture');
        if (!complex) await page.getByTestId('radio-timing-tbc').click();
      }
      if (complex) await page.getByRole('tab', { name: 'Tickets', exact: true }).click();
      else if (edit) await page.getByTestId('button-tab-tickets').click();
      await page.getByTestId('button-add-ticket-class').click();
      const removeButtons = page.locator('[data-testid^="button-remove-ticket-"]');
      if (await removeButtons.count()) await removeButtons.first().click();
      await page.locator('[data-testid^="input-ticket-name-"]').last().fill('Saved private ticket');
      await page.locator('[data-testid^="switch-free-"]').last().check();
      await page.getByLabel('Selected members only').last().check();
      await expect(page.getByText('No members selected. This ticket will be hidden from everyone.')).toBeVisible();
      await page.getByLabel('Search selected ticket members').fill('Fixture');
      await page.getByRole('button', { name: /Add Fixture Member/ }).click();
      await expect(page.getByText('Fixture Member (member@example.invalid)', { exact: true })).toBeVisible();
      if (complex) await page.getByTestId('button-save').click();
      else if (edit) await page.getByTestId('button-save-event').click();
      else await page.getByRole('button', { name: 'Create Event', exact: true }).click();
      const findSaved = () => complex
        ? writes.find(write => write.entity === 'ComplexEventTicketClass')?.data
        : writes.find(write => write.entity === 'Event')?.data.pricing_config?.ticket_classes?.[0];
      await expect.poll(findSaved).toMatchObject({ audience_mode: 'selected_members', selected_member_ids: [memberId], role_ids: [], member_group_ids: [], create_member_records: false, new_member_role_id: null });
      const saved = findSaved();
      await page.unroute('**/*');
      await mount(page, { actualEditor: true, complex, edit: true, tickets: [saved] });
      if (complex) await page.getByRole('tab', { name: 'Tickets', exact: true }).click();
      else await page.getByTestId('button-tab-tickets').click();
      await page.getByText('Saved private ticket', { exact: true }).first().click();
      await expect(page.getByLabel('Selected members only')).toBeChecked();
      await expect(page.getByText('Fixture Member (member@example.invalid)', { exact: true })).toBeVisible();
    });

    test(`${complex ? 'complex' : 'simple'} ${edit ? 'edit' : 'create'} audience search, hydration and explicit clearing`, async ({ page }) => {
      const { searches } = await mount(page, { editor: true, complex, edit, ticket: { id: 'ticket', role_ids: ['role'], member_group_ids: ['group'], visibility_mode: 'public_only', create_member_records: true, new_member_role_id: 'role' } });
      await page.getByLabel('Selected members only').check();
      await expect(page.getByRole('alert')).toHaveText(/No members selected/);
      const state = () => page.getByTestId('ticket-state').textContent().then(JSON.parse);
      expect(await state()).toMatchObject({ audience_mode: 'selected_members', role_ids: [], member_group_ids: [], visibility_mode: 'members_only', create_member_records: false, new_member_role_id: null });
      await page.getByLabel('Search selected ticket members').fill('Fixture');
      await page.getByRole('button', { name: /Add Fixture Member/ }).click();
      await expect(page.getByRole('alert')).toHaveCount(0);
      await expect(page.getByText('Fixture Member (member@example.invalid)', { exact: true })).toBeVisible();
      expect((await state()).selected_member_ids).toEqual([memberId]);
      expect(searches[0].searchParams.get('event_type')).toBe(complex ? 'complex' : 'simple');
      expect(searches[0].searchParams.get('event_id')).toBe(edit ? eventId : null);
      expect(searches[0].searchParams.get('group_id')).toBe(groupId);
      await page.getByRole('button', { name: 'Choose role audience' }).click();
      expect(await state()).toMatchObject({ audience_mode: 'legacy', selected_member_ids: [], role_ids: ['role'] });
      await page.getByLabel('Selected members only').check();
      await page.getByRole('button', { name: 'Choose public audience' }).click();
      expect(await state()).toMatchObject({ audience_mode: 'legacy', selected_member_ids: [], visibility_mode: 'public_only' });
    });
  }

  test(`${complex ? 'complex' : 'simple'} private tickets never become guest teasers; eligible sibling remains`, async ({ page }) => {
    await mount(page, { complex });
    await expect(page.getByText('Independent public ticket', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Private invitation', { exact: true })).toHaveCount(0);
    await page.evaluate(member => window.fixture.session(member), member);
    await expect(page.getByText('Private invitation', { exact: true }).first()).toBeVisible();
    await page.evaluate(() => window.fixture.session(null));
    await expect(page.getByText('Private invitation', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Independent public ticket', { exact: true }).first()).toBeVisible();
  });

  test(`${complex ? 'complex' : 'simple'} client allowlist cannot replace server eligibility`, async ({ page }) => {
    await mount(page, { complex, signedIn: true, tickets: [{ ...privateTicket, private_ticket_eligible: false, selected_member_ids: [memberId] }, sibling] });
    await expect(page.getByText('Independent public ticket', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Private invitation', { exact: true })).toHaveCount(0);
  });
}

test('simple legacy empty classes retain default while server-redacted configured classes do not', async ({ page }) => {
  await mount(page, { signedIn: true, tickets: [] });
  await expect(page.getByText('Standard Ticket', { exact: true }).first()).toBeVisible();
  await page.unroute('**/*');
  await mount(page, { signedIn: true, tickets: [], configured: true });
  await expect(page.getByText('Standard Ticket', { exact: true })).toHaveCount(0);
});

test('simple account switch reconciles selected private ticket to the valid sibling', async ({ page }) => {
  const { event } = await mount(page, { signedIn: true });
  await expect(page.locator('#ticket-private')).toHaveAttribute('data-state', 'checked');
  event.pricing_config.ticket_classes = [sibling];
  await page.evaluate(member => window.fixture.session({ ...member, id: 'another-member' }), member);
  await expect(page.getByText('Private invitation', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Independent public ticket', { exact: true }).first()).toBeVisible();
  await expect(page.getByTestId('ticket-class-private')).toHaveCount(0);
});

test('complex legacy events without configured tickets retain the schedule', async ({ page }) => {
  await mount(page, {
    complex: true, tickets: [],
    tracks: [{ id: 'legacy-track', name: 'Legacy stream' }],
    sessions: [{ id: 'legacy-session', title: 'Legacy scheduled session', start_time: '2099-06-01T09:00:00Z', end_time: '2099-06-01T10:00:00Z', track_names: ['Legacy stream'], speaker_ids: [] }],
  });
  await expect(page.getByText('Legacy scheduled session', { exact: true }).first()).toBeVisible();
});
