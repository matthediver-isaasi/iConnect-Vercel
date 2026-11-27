import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  snapshotFunnelTicket, funnelLineTotal, assertFunnelCommercialCompatibility,
  createFunnelSelectionResolver, loadFunnelCommercialAuthority,
} from './eventFunnelCommercial.js';
import { publicTicketSimpleBaseTotal } from './publicTicketSimpleQuote.js';
import { publicFunnelSnapshot } from './eventFunnelJourneyHandler.js';

const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tenant = uuid(1), eventId = uuid(2), memberId = uuid(3);
const authority = {
  stripe: { provider: 'stripe', feature: 'events', mode: 'test', accountFingerprint: 'account-one' },
  accounting: { name: 'xero', connectionId: uuid(4), company: 'one', environment: 'production' },
  accountingSettings: { xero_sales_account_code: '200' }, funding: { allowVoucherPayment: true, allowTrainingFundPayment: true },
};
const ticket = { id: 'admission', name: 'Admission', price: 12.5, currency: 'gbp', visibility_mode: 'members_and_public' };
const event = { id: eventId, tenant_id: tenant, title: 'Source', status: 'published', pricing_config: { ticket_classes: [ticket] } };
const person = { first_name: 'Example', last_name: 'Buyer', email: 'buyer@example.test' };
function fixture({ guest = false, eventChanges = {}, ticketChanges = {}, settings = [], tables = {}, errorTable } = {}) {
  const selected = { ...ticket, ...ticketChanges };
  const current = { ...event, ...eventChanges, pricing_config: { ticket_classes: [selected] } };
  const rows = { event: [current], member: guest ? [] : [{ ...person, id: memberId, tenant_id: tenant, role_id: uuid(6) }],
    member_group_assignment: [], system_settings: settings.map(row => ({ tenant_id: tenant, ...row })), ...tables };
  const db = { from(table) {
    const filters = []; let single = false;
    const query = {
      select() { return this; }, eq(key, value) { filters.push(row => row[key] === value); return this; },
      in(key, values) { filters.push(row => values.includes(row[key])); return this; },
      filter(key, op, pattern) { assert.equal(op, 'imatch'); filters.push(row => row.email === person.email); return this; },
      limit() { return this; }, order() { return this; }, maybeSingle() { single = true; return this; },
      then(resolve, reject) {
        const data = (rows[table] || []).filter(row => filters.every(predicate => predicate(row)));
        return Promise.resolve(table === errorTable ? { error: { code: 'XX000' } } : { data: single ? data[0] || null : data })
          .then(resolve, reject);
      },
    };
    return query;
  } };
  const node = { id: 'source', event: { id: eventId, kind: 'simple', tenantId: tenant }, ticketIds: ['admission'] };
  const input = { owner: { tenantId: tenant, memberId: guest ? null : memberId }, node, tickets: [{ id: 'admission', quantity: 1 }],
    answers: { purchaser: person, attendeesByTicket: { admission: [{ ...person, dietary_selections: ['forged'], role_id: 'forged' }] } },
    previousHolds: [], snapshot: { graph: { entry: 'source' }, drafts: {}, holds: [] },
    selections: [{ nodeId: 'source' }], rereserve: false };
  return { input, rows, resolve: createFunnelSelectionResolver({ db, loadAuthority: async () => authority }) };
}

test('frozen simple pricing preserves existing offer arithmetic for every quantity', () => {
  for (const offer of [{}, { offer_type: 'bogo', bogo_buy_quantity: 2, bogo_get_free_quantity: 1, bogo_logic_type: 'buy_x_get_y_free' },
    { offer_type: 'bogo', bogo_buy_quantity: 2, bogo_get_free_quantity: 1, bogo_logic_type: 'enter_total_pay_less' },
    { offer_type: 'bulk_discount', bulk_discount_threshold: 3, bulk_discount_percentage: 15 }]) {
    const selected = { ...ticket, ...offer };
    const frozen = snapshotFunnelTicket(event, selected, 'simple', authority, person);
    for (let quantity = 1; quantity <= 100; quantity++) {
      assert.equal(funnelLineTotal(frozen, quantity), Math.round(publicTicketSimpleBaseTotal(selected, quantity) * 100));
    }
  }
});
test('complex prices stay per attendee and preserve tax-inclusive prices', () => {
  const frozen = snapshotFunnelTicket(event, { ...ticket, vat_rate_percentage: 20, vat_rate_key: 'tax' }, 'complex', authority, person);
  assert.equal(funnelLineTotal(frozen, 2), 2500);
  assert.deepEqual(frozen.tax, { percentage: 20, key: 'tax', lineAmountType: 'Inclusive' });
  assert.throws(() => snapshotFunnelTicket(event, { ...ticket, price: 'invalid' }, 'simple', authority, person));
  assert.throws(() => snapshotFunnelTicket(event, { ...ticket, is_group_ticket: true, group_size: 0 }, 'simple', authority, person));
  assert.equal(funnelLineTotal(snapshotFunnelTicket(event, { ...ticket, price: 12.345 }, 'simple', authority, person), 2), 2469);
});
test('payment methods intersect only payable lines without granting guest Invoice/PO', () => {
  const source = snapshotFunnelTicket(event, ticket, 'simple', authority, null);
  const po = snapshotFunnelTicket({ ...event, allow_public_invoice_po: true }, ticket, 'simple', authority, null);
  const free = snapshotFunnelTicket(event, { ...ticket, is_free: true }, 'simple', { ...authority, stripe: null }, null);
  assert.deepEqual(assertFunnelCommercialCompatibility([{ quantity: 1, priceSnapshot: source }, { quantity: 1, priceSnapshot: po },
    { quantity: 1, priceSnapshot: free }]).paymentMethods, ['card']);
  assert.deepEqual(assertFunnelCommercialCompatibility([{ quantity: 1, priceSnapshot: free }]).paymentMethods, ['free']);
  assert.throws(() => assertFunnelCommercialCompatibility([{ quantity: 1, priceSnapshot: source },
    { quantity: 1, priceSnapshot: { ...po, paymentMethods: ['public_invoice_po'] } }]), { code: 'INCOMPATIBLE_PAYMENT' });
});
test('currency and account changes reject optional additions', () => {
  const source = snapshotFunnelTicket(event, ticket, 'simple', authority, person);
  assert.throws(() => assertFunnelCommercialCompatibility([{ quantity: 1, priceSnapshot: source },
    { quantity: 1, priceSnapshot: { ...source, currency: 'EUR' } }]), { code: 'INCOMPATIBLE_CURRENCY' });
  assert.throws(() => assertFunnelCommercialCompatibility([{ quantity: 1, priceSnapshot: source },
    { quantity: 1, priceSnapshot: { ...source, commercial: { ...authority, accounting: { name: 'quickbooks', company: 'two' } } } }]),
  { code: 'INCOMPATIBLE_COMPANY' });
});
test('persisted source and fresh add-on accounts match regardless of JSONB property order', () => {
  const source = snapshotFunnelTicket(event, ticket, 'simple', authority, person);
  // PostgreSQL JSONB does not preserve JavaScript object insertion order.
  const jsonbRoundTrip = value => Array.isArray(value) ? value.map(jsonbRoundTrip)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort()
      .map(name => [name, jsonbRoundTrip(value[name])])) : value;
  const savedSource = JSON.parse(JSON.stringify(jsonbRoundTrip(source)));
  const addon = snapshotFunnelTicket(event, { ...ticket, id: 'wednesday' }, 'simple', authority, person);
  const result = assertFunnelCommercialCompatibility([
    { quantity: 1, price_snapshot: savedSource }, { quantity: 1, priceSnapshot: addon },
  ]);
  assert.equal(result.totalMinor, 2500);
  assert.deepEqual(result.paymentMethods, ['card', 'account']);
  for (const changedAuthority of [
    { ...authority, stripe: { ...authority.stripe, accountFingerprint: 'different-account' } },
    { ...authority, stripe: { ...authority.stripe, mode: 'live' } },
    { ...authority, accounting: { ...authority.accounting, company: 'different-company' } },
    { ...authority, accounting: { ...authority.accounting, connectionId: uuid(99) } },
  ]) {
    const changed = snapshotFunnelTicket(event, ticket, 'simple', changedAuthority, person);
    assert.throws(() => assertFunnelCommercialCompatibility([
      { quantity: 1, price_snapshot: savedSource }, { quantity: 1, priceSnapshot: changed },
    ]), { code: 'INCOMPATIBLE_COMPANY' });
  }
});
test('public funnel selections accept guests but still enforce signed-in role restrictions', async () => {
  const guest = fixture({ guest: true, ticketChanges: { role_match_only: true, role_ids: [uuid(6)] } });
  assert.equal((await guest.resolve(guest.input)).lines.length, 1);
  const matching = fixture({ ticketChanges: { role_match_only: true, role_ids: [uuid(6)] } });
  assert.equal((await matching.resolve(matching.input)).lines.length, 1);
  const denied = fixture({ ticketChanges: { role_match_only: true, role_ids: [uuid(99)] } });
  await assert.rejects(denied.resolve(denied.input), /eligibility/);
  const memberOnly = fixture({ guest: true, ticketChanges: {
    visibility_mode: 'members_only', role_match_only: true, role_ids: [uuid(6)],
  } });
  await assert.rejects(memberOnly.resolve(memberOnly.input), /access/);
});

test('selection reloads canonical prices and normalizes attendee fields without trusting injected authority', async () => {
  const f = fixture();
  f.input.answers.priceSnapshot = { unitMinor: 1 };
  const result = await f.resolve(f.input);
  assert.equal(result.lines[0].priceSnapshot.unitMinor, 1250);
  assert.equal(result.answers.attendeesByTicket.admission[0].role_id, undefined);
  assert.equal(result.answers.attendeesByTicket.admission[0].dietary_selections, null);
  assert.deepEqual(result.lines[0].priceSnapshot.purchaser, { ...person, organization: '' });
});
test('private, role-restricted, unreleased, closed and program tickets fail without side effects', async () => {
  for (const options of [
    { guest: true, ticketChanges: { audience_mode: 'selected_members', selected_member_ids: [memberId] } },
    { ticketChanges: { audience_mode: 'selected_members', selected_member_ids: [] } },
    { ticketChanges: { visibility_mode: 'public_only' } },
    { ticketChanges: { audience_mode: 'unknown' } },
    { eventChanges: { event_state: 'closed' } }, { eventChanges: { program_tag: 'entitlement' } },
    { eventChanges: { waiting_list_enabled: true } },
    { eventChanges: { registration_closes_at: '2000-01-01' } },
    { eventChanges: { registration_closes_at: 'invalid' } },
    { errorTable: 'system_settings' },
  ]) {
    const f = fixture(options);
    await assert.rejects(f.resolve(f.input));
    assert.equal(f.input.snapshot.holds.length, 0);
  }
});
test('group event self-only rule applies even to public groups', async () => {
  const f = fixture({ guest: true, eventChanges: { member_group_id: uuid(9), group_event_public: true } });
  f.input.answers.attendeesByTicket.admission[0].email = 'someone-else@example.test';
  await assert.rejects(f.resolve(f.input), /self-registration/);
});
test('members cannot register others when the event setting is off; guests and default events are unaffected', async () => {
  const off = fixture({ eventChanges: { members_can_register_others: false } });
  off.input.answers.attendeesByTicket.admission[0].email = 'colleague@example.test';
  await assert.rejects(off.resolve(off.input), /only allows members to register themselves/);
  const selfOnly = fixture({ eventChanges: { members_can_register_others: false } });
  await selfOnly.resolve(selfOnly.input);
  const allowed = fixture();
  allowed.input.answers.attendeesByTicket.admission[0].email = 'colleague@example.test';
  await allowed.resolve(allowed.input);
  const guest = fixture({ guest: true, eventChanges: { members_can_register_others: false } });
  guest.input.answers.attendeesByTicket.admission[0].email = 'colleague@example.test';
  await guest.resolve(guest.input);
});
test('current terms are required, and saving another purchaser into draft answers cannot change the reserved purchaser', async () => {
  const f = fixture({ guest: true, settings: [{ setting_key: 'event_booking_terms', setting_value: '<p>Terms</p>' }] });
  await assert.rejects(f.resolve(f.input), /booking terms/);
  f.input.answers.terms_accepted = true; f.input.answers.terms_content = '<p>Terms</p>';
  const first = await f.resolve(f.input);
  f.input.snapshot.holds = [{ node_id: 'source', ticket_id: 'admission', quantity: 1, price_snapshot: first.lines[0].priceSnapshot }];
  f.input.answers.purchaser = { ...person, email: 'replacement@example.test' };
  f.input.snapshot.drafts.source = { purchaser: f.input.answers.purchaser };
  await assert.rejects(f.resolve(f.input), /original purchaser/);
});
test('live economics are retained and explicit re-reservation uses current prices', async () => {
  const f = fixture({ ticketChanges: { price: 30 } });
  const original = snapshotFunnelTicket(event, ticket, 'simple', authority, person);
  f.input.previousHolds = [{ node_id: 'source', ticket_id: 'admission', quantity: 1, price_snapshot: original }];
  assert.equal((await f.resolve(f.input)).lines[0].priceSnapshot.unitMinor, 1250);
  f.input.rereserve = true;
  assert.equal((await f.resolve(f.input)).lines[0].priceSnapshot.unitMinor, 3000);
});
test('authority stores a credential fingerprint, never the credential; browser projections redact internal financial routing', async () => {
  const auth = await loadFunnelCommercialAuthority(null, tenant, {
    loadInvoiceContext: async () => ({ provider: { name: 'quickbooks', connectionId: 'connection', realmId: 'company', environment: 'sandbox' } }),
    loadPaymentPolicy: async () => ({}),
    loadStripe: async () => ({ is_enabled: true, secret_key: 'fake-test-credential', publishable_key: 'fake-publishable', mode: 'test' }),
  });
  assert.doesNotMatch(JSON.stringify(auth), /fake-test-credential|fake-publishable/);
  assert.equal(auth.stripe.accountFingerprint.length, 64);
  const snapshot = publicFunnelSnapshot({ graph: { entry: 'source' }, holds: [{ node_id: 'source',
    price_snapshot: { ...snapshotFunnelTicket(event, ticket, 'simple', auth, person), purchaser: person } }] });
  assert.equal(snapshot.purchaser.email, person.email);
  assert.doesNotMatch(JSON.stringify(snapshot), /accountFingerprint|accountingSettings|connectionId|company|accountCode/);
});
