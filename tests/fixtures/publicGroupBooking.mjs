import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createLegacySimpleHarness } from './ticketReleaseLegacyHandlers.mjs';

const slot = '__publicGroupBooking';
let complexHandler;
async function loadComplexHandler() {
  const path = 'api/public/complex-event-booking.js';
  const source = await readFile(path, 'utf8');
  const mocks = new Map();
  for (const [, names, specifier] of source.matchAll(/import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"];?/g)) {
    if (/ticketAccess|complexEventPricing|ticketReleaseAccess|eventOptionSelections|attendeeJobTitleEnrichment/.test(specifier)) continue;
    mocks.set(specifier, names.replace(/[{}]/g, '').split(',').map(s => s.trim()).filter(Boolean)
      .map(name => `export function ${name}(...args) { return globalThis.${slot}.dependency(${JSON.stringify(name)}, args); }`).join('\n'));
  }
  const result = await build({
    entryPoints: [path], bundle: true, write: false, platform: 'node', format: 'esm',
    plugins: [{ name: 'isolated-group-booking', setup(b) {
      b.onResolve({ filter: /.*/ }, args => mocks.has(args.path) ? { path: args.path, namespace: 'fixture' } : undefined);
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: mocks.get(args.path), loader: 'js' }));
    } }],
  });
  return (await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)).default;
}

export async function groupBooking({ complex = false, flag = true, identity = 'guest', expired = false, inactive = false, forged = false, count = 1, ticketMode = 'members_and_public', requestFlag = true, otherAttendee = false, restricted = false } = {}) {
  const member = { id: 'member-a', tenant_id: 'tenant-a', role_id: 'member-role', email: 'member@example.invalid', first_name: 'Member', last_name: 'Fixture' };
  const attendee = { email: identity === 'guest' ? 'guest@example.invalid' : member.email, first_name: 'Guest', last_name: 'Fixture', organization: 'Fixture' };
  const ticket = { id: 'ticket-a', name: 'Free', price: 0, is_free: true, visibility_mode: ticketMode, is_unlimited_tickets: true,
    ...(restricted ? { role_match_only: true, role_ids: ['member-role'] } : {}) };
  const event = { member_group_id: 'group-a', group_event_public: flag, available_seats: null, pricing_config: { ticket_classes: [ticket] } };
  if (flag === null) delete event.group_event_public;
  const attendees = Array.from({ length: count }, () => ({ ...attendee, ...(otherAttendee ? { email: 'other@example.invalid' } : {}) }));
  const sessionMember = forged === 'different-session' ? { ...member, id: 'other-member', email: 'other@example.invalid' }
    : identity === 'guest' || forged ? null : member;
  const harness = createLegacySimpleHarness({ event, sessionMember });
  const originalRpc = harness.db.rpc;
  harness.db.rpc = async (name, args) => {
    if (name === 'check_oneoff_ticket_capacity') {
      assert.equal(args.p_event_id, 'event-a');
      harness.calls.push({ rpc: name, args });
      return { data: { ok: true }, error: null };
    }
    return originalRpc(name, args);
  };
  Object.assign(harness.rows, {
    member: [member],
    member_group_assignment: identity === 'active' ? [{ member_id: member.id, group_id: 'group-a', expires_at: expired ? '2000-01-01T00:00:00Z' : null }] : [],
    member_group: [{ id: 'group-a', is_active: !inactive }],
    complex_event: harness.rows.event,
    complex_event_ticket_class: [{ ...ticket, tenant_id: 'tenant-a', complex_event_id: 'event-a' }],
    complex_event_booking: [],
  });
  const originalDependency = harness.dependency;
  harness.dependency = (name, args) => {
    if (name === 'needsPublicTicketMemberCreation') return false;
    if (name === 'assertPublicTicketPurchaser') return undefined;
    if (name === 'scheduleComplexEventReminders') return undefined;
    return originalDependency(name, args);
  };
  if (!complex) {
    const { response } = await harness.invoke('createOneOffEventBooking', {
      eventId: 'event-a', isGuestBooking: identity === 'guest', guestInfo: attendee,
      memberEmail: member.email, attendees,
      registrationMode: 'colleagues', ticketsRequired: count, totalCost: 0, paymentMethod: 'free',
      ticketClassId: ticket.id, group_event_public: requestFlag,
    });
    assert.deepEqual(harness.unexpected, []);
    return { response, harness };
  }
  const previous = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Network forbidden'); };
  globalThis[slot] = harness;
  process.env.SUPABASE_URL = 'https://fixture.invalid';
  process.env.SUPABASE_SERVICE_KEY = 'fixture';
  try {
    complexHandler ||= await loadComplexHandler();
    const res = { statusCode: 200, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await complexHandler({ method: 'POST', body: {
      event_id: 'event-a', ticket_class_id: ticket.id,
      attendees,
      purchaser_info: attendee, payment_method: 'free', group_event_public: requestFlag,
    } }, res);
    assert.deepEqual(harness.unexpected, []);
    return { response: res.body, harness, status: res.statusCode };
  } finally {
    globalThis.fetch = previous;
    delete globalThis[slot];
  }
}
