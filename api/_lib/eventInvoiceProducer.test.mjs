import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  enqueueCheckoutEventInvoice, eventInvoiceContact, simpleEventInvoiceLines,
  complexEventInvoiceLines, capturedEventSettlement,
} from './eventInvoiceProducer.js';
import { validRecoverySnapshot } from './eventInvoiceRecovery.js';

function fixture({ provider = 'xero', enabled = 'true', settingsError = false, tokens, enqueueError = false } = {}) {
  const calls = [], queued = [];
  const rows = {
    system_settings: [
      ['xero_invoice_enabled', enabled], ['xero_sales_account_code', '200'],
      ['xero_invoice_status', 'AUTHORISED'], ['xero_stripe_bank_account_code', '090'],
    ].map(([setting_key, setting_value]) => ({ setting_key, setting_value })),
    tenant_accounting_settings: { active_provider: provider },
    xero_token: tokens || [{ id: 'connection-a', tenant_id: 'xero-org-a' }],
  };
  const db = {
    from(table) {
      const call = { table, filters: [] }; calls.push(call);
      const query = {
        select(columns) { call.columns = columns; return query; },
        eq(key, value) { call.filters.push([key, value]); return query; },
        in(key, values) { call.filters.push([key, values]); return query; },
        update(value) { call.update = value; return query; },
        maybeSingle() { return query; },
        then(resolve, reject) {
          return Promise.resolve({
            data: rows[table] || null,
            error: settingsError && table === 'system_settings' ? { message: 'offline' } : null,
          }).then(resolve, reject);
        },
      };
      return query;
    },
  };
  const deps = {
    logger: { error() {} },
    enqueue: async args => {
      queued.push(args);
      if (enqueueError) throw new Error('queue unavailable');
      return { status: validRecoverySnapshot(args.snapshot) ? 'pending' : 'needs_review' };
    },
  };
  const event = {
    id: 'event-a', tenant_id: 'tenant-a', title: 'Historical event',
    internal_reference: 'PROJECT-A', xero_account_code: ' 201 ',
    pricing_config: { ticket_classes: [{ id: 'ticket-a', vat_rate_key: 'NONE', vat_rate_percentage: 0 }] },
  };
  const contact = eventInvoiceContact({
    source: 'booking', member: { id: 'member-a', first_name: 'Actual', last_name: 'Purchaser', email: 'purchaser@example.test' },
  });
  const input = {
    db, tenantId: 'tenant-a', source: 'booking', bookingGroupReference: 'BOOK-A',
    event, amount: 25, currency: 'gbp', paymentMethod: 'account', contact,
    purchaseOrderNumber: 'PO-ORIGINAL', now: new Date('2026-01-01T10:00:00Z'),
    buildLines: accountCode => simpleEventInvoiceLines({
      event, bookingAttendees: [{ first_name: 'Different', last_name: 'Attendee', email: 'attendee@example.test' }],
      ticketsRequired: 1, ticketClassName: 'Standard', ticketClassId: 'ticket-a',
      ticketClassPrice: 25, totalCost: 25, voucherAmountApplied: 0,
      validatedTrainingFundAmount: 0, validatedRemainingBalance: 25,
    }, accountCode),
  };
  return { db, deps, input, calls, queued, event };
}

function paymentIntent(overrides = {}) {
  return {
    id: 'pi_original', status: 'succeeded', amount: 2500, amount_received: 2500,
    currency: 'gbp', metadata: { event_id: 'event-a' }, capture_method: 'automatic',
    created: 1700000000,
    latest_charge: {
      id: 'ch_original', status: 'succeeded', paid: true, captured: true,
      amount_captured: 2500, currency: 'gbp', created: 1767225900,
      payment_intent: 'pi_original', amount_refunded: 0,
    },
    ...overrides,
  };
}

test('simple checkout captures historical purchaser, PO, dates, tax, tracking, account and currency without provider calls', async () => {
  const f = fixture();
  assert.deepEqual(await enqueueCheckoutEventInvoice(f.input, f.deps), { status: 'pending', queued: true });
  const { snapshot, ...scope } = f.queued[0];
  assert.equal(scope.tenantId, 'tenant-a');
  assert.equal(scope.source, 'booking');
  assert.equal(scope.bookingGroupReference, 'BOOK-A');
  assert.deepEqual(snapshot.provider, { connectionId: 'connection-a', xeroTenantId: 'xero-org-a' });
  assert.equal(snapshot.invoice.Contact.Name, 'Actual Purchaser');
  assert.equal(snapshot.invoice.Contact.EmailAddress, 'purchaser@example.test');
  assert.equal(snapshot.invoice.Reference, 'PO-ORIGINAL');
  assert.equal(snapshot.invoice.Date, '2026-01-01');
  assert.equal(snapshot.invoice.DueDate, '2026-01-31');
  assert.equal(snapshot.invoice.CurrencyCode, 'GBP');
  assert.equal(snapshot.invoice.Status, 'AUTHORISED');
  assert.equal(snapshot.invoice.LineAmountTypes, 'Exclusive');
  assert.equal(snapshot.invoice.LineItems[0].AccountCode, '201');
  assert.equal(snapshot.invoice.LineItems[0].TaxType, 'NONE');
  assert.equal(snapshot.invoice.LineItems[0].TaxAmount, 0);
  assert.deepEqual(snapshot.invoice.LineItems[0].Tracking, [{ Name: 'Projects', Option: 'PROJECT-A' }]);
  f.event.internal_reference = 'CHANGED';
  f.input.contact.name = 'CHANGED';
  assert.equal(snapshot.contact.name, 'Actual Purchaser');
  assert.equal(snapshot.invoice.LineItems[0].Tracking[0].Option, 'PROJECT-A');
  assert.ok(f.calls.every(call => call.filters.some(([key, value]) => ['tenant_id', 'app_tenant_id'].includes(key) && value === 'tenant-a')));
  assert.equal(f.calls.find(call => call.table === 'xero_token').columns, 'id, tenant_id');
});

test('complex checkout preserves original org address and each ticket/credit line', async () => {
  const f = fixture();
  f.input.source = 'complex_event_booking';
  f.input.contact = eventInvoiceContact({
    source: f.input.source,
    org: { id: 'org-a', name: 'Historical company', invoicing_email: 'billing@example.test', address: 'Street\nTown\nAA1 1AA' },
  });
  const items = [{
    attendees: [{ first_name: 'An', last_name: 'Attendee' }, { email: 'other@example.test' }],
    serverTicket: { name: 'Early ticket' }, authoritativePrice: 20,
    ticketClass: { vat_rate_key: 'NONE', vat_rate_percentage: 0 },
  }];
  f.input.buildLines = account => complexEventInvoiceLines({
    event: f.event, resolvedItems: items, actualVoucherApplied: 10, actualTfApplied: 5,
  }, account);
  const result = await enqueueCheckoutEventInvoice(f.input, f.deps);
  // Old credit lines relied on mutable account tax defaults. Keep evidence but
  // do not send an invoice with invented tax treatment.
  assert.equal(result.status, 'needs_review');
  const snapshot = f.queued[0].snapshot;
  const invoice = snapshot.originalInvoice;
  assert.equal(invoice.Contact.Name, 'Historical company');
  assert.deepEqual(invoice.Contact.Addresses, [{ AddressType: 'POBOX', AddressLine1: 'Street', City: 'Town', PostalCode: 'AA1 1AA' }]);
  assert.deepEqual(invoice.LineItems.map(line => [line.Quantity, line.UnitAmount]), [[2, 20], [1, -10], [1, -5]]);
  assert.match(invoice.LineItems[0].Description, /Early ticket/);
  assert.match(snapshot.reviewReasons.join(' '), /VAT/);
});

test('complex paid cart preserves historical currency and enqueues one operation for multiple attendees', async () => {
  const f = fixture();
  Object.assign(f.input, {
    source: 'complex_event_booking', currency: 'EUR', paymentMethod: 'card', paymentIntentId: 'pi_original',
    paymentIntent: paymentIntent({ currency: 'eur', latest_charge: { ...paymentIntent().latest_charge, currency: 'eur' } }),
  });
  f.input.buildLines = accountCode => complexEventInvoiceLines({
    event: f.event,
    resolvedItems: [{
      serverTicket: { name: 'Historical ticket' }, authoritativePrice: 12.5,
      ticketClass: { vat_rate_key: 'NONE', vat_rate_percentage: 0 },
      attendees: [{ first_name: 'First' }, { first_name: 'Second' }],
    }],
    actualVoucherApplied: 0, actualTfApplied: 0,
  }, accountCode);
  assert.equal((await enqueueCheckoutEventInvoice(f.input, f.deps)).status, 'pending');
  assert.equal(f.queued.length, 1);
  assert.equal(f.queued[0].source, 'complex_event_booking');
  assert.equal(f.queued[0].snapshot.invoice.CurrencyCode, 'EUR');
  assert.equal(f.queued[0].snapshot.invoice.LineItems[0].Quantity, 2);
  assert.equal(f.queued[0].snapshot.settlement.currency, 'EUR');
});

test('explicit guest purchaser is preserved; complex attendee is never invented as purchaser', () => {
  const guestInfo = { first_name: 'Guest', last_name: 'Buyer', email: 'buyer@example.test', organization: ' Guest company ' };
  const contact = eventInvoiceContact({ source: 'booking', isGuestBooking: true, guestInfo });
  assert.equal(contact.name, 'Guest company');
  assert.equal(contact.provenance.kind, 'guest_purchaser');
  assert.equal(eventInvoiceContact({ source: 'complex_event_booking', guestInfo, attendees: [guestInfo] }), null);
});

test('captured Stripe settlement is exact, uses charge date and never PI initiation/retry date', async () => {
  const f = fixture();
  Object.assign(f.input, { paymentMethod: 'card', paymentIntentId: 'pi_original', paymentIntent: paymentIntent() });
  assert.equal((await enqueueCheckoutEventInvoice(f.input, f.deps)).status, 'pending');
  const settlement = f.queued[0].snapshot.settlement;
  assert.equal(settlement.amount, 25);
  assert.equal(settlement.paidAt, new Date(1767225900 * 1000).toISOString());
  assert.equal(settlement.accountCode, '090');
});

for (const [label, change] of [
  ['uncaptured authorization', { status: 'requires_capture', amount_received: 0 }],
  ['wrong captured amount including unattributed donation', { amount: 3000, amount_received: 3000 }],
  ['wrong currency', { currency: 'eur' }],
  ['other event', { metadata: { event_id: 'other-event' } }],
  ['missing charge date', { latest_charge: 'ch_unexpanded' }],
  ['manual capture date unavailable', { capture_method: 'manual' }],
]) {
  test(`Stripe ${label} becomes durable review, not a payment`, async () => {
    const f = fixture();
    Object.assign(f.input, { paymentMethod: 'card', paymentIntentId: 'pi_original', paymentIntent: paymentIntent(change) });
    assert.equal((await enqueueCheckoutEventInvoice(f.input, f.deps)).status, 'needs_review');
    assert.equal(f.queued[0].snapshot.invoice, null);
    assert.equal(f.queued[0].snapshot.settlement, null);
    assert.ok(f.queued[0].snapshot.originalInvoice);
  });
}

test('refunded or missing-bank capture cannot become settlement evidence', () => {
  const args = { paymentIntentId: 'pi_original', amount: 25, currency: 'GBP', eventId: 'event-a', accountCode: '090' };
  const intent = paymentIntent();
  intent.latest_charge.amount_refunded = 1;
  assert.throws(() => capturedEventSettlement({ ...args, paymentIntent: intent }));
  assert.throws(() => capturedEventSettlement({ ...args, paymentIntent: paymentIntent(), accountCode: null }));
});

test('missing purchaser, VAT and context evidence are durably reviewable', async () => {
  for (const failure of ['contact', 'tax', 'gross', 'context', 'connection']) {
    const f = fixture({ settingsError: failure === 'context', tokens: failure === 'connection' ? [] : undefined });
    if (failure === 'contact') f.input.contact = null;
    if (failure === 'tax') delete f.event.pricing_config.ticket_classes[0].vat_rate_percentage;
    if (failure === 'gross') f.event.pricing_config.ticket_classes[0].vat_rate_percentage = 20;
    assert.equal((await enqueueCheckoutEventInvoice(f.input, f.deps)).status, 'needs_review');
    assert.equal(validRecoverySnapshot(f.queued[0].snapshot), false);
  }
});

test('PO to follow remains TBC in immutable evidence', async () => {
  const f = fixture(); f.input.poToFollow = true;
  await enqueueCheckoutEventInvoice(f.input, f.deps);
  assert.equal(f.queued[0].snapshot.invoice.Reference, 'TBC');
  assert.equal(f.queued[0].snapshot.purchaseOrderNumber, 'PO-ORIGINAL');
});

test('free, fully funded, public invoice PO, disabled and non-Xero checkouts are excluded', async () => {
  for (const patch of [{ paymentMethod: 'free' }, { amount: 0 }, { paymentMethod: 'public_invoice_po' }]) {
    const f = fixture();
    assert.deepEqual(await enqueueCheckoutEventInvoice({ ...f.input, ...patch }, f.deps), { status: 'not_applicable' });
    assert.equal(f.calls.length, 0); assert.equal(f.queued.length, 0);
  }
  for (const options of [{ enabled: 'false' }, { provider: 'none' }, { provider: 'quickbooks' }]) {
    const f = fixture(options);
    assert.deepEqual(await enqueueCheckoutEventInvoice(f.input, f.deps), { status: 'not_applicable' });
    assert.equal(f.queued.length, 0);
  }
});

test('queue failure is explicit and cannot reverse booking, debit credits or clear a paid state', async () => {
  const f = fixture({ enqueueError: true });
  const result = await enqueueCheckoutEventInvoice(f.input, f.deps);
  assert.equal(result.status, 'needs_review'); assert.equal(result.queued, false);
  assert.match(result.warning, /Booking confirmed/);
  const updates = f.calls.filter(call => call.update);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].table, 'booking');
  assert.deepEqual(updates[0].update, { invoice_recovery_status: 'needs_review', invoice_recovery_next_attempt_at: null });
  assert.deepEqual(updates[0].filters, [['tenant_id', 'tenant-a'], ['booking_group_reference', 'BOOK-A']]);
});

test('missing durable result is never reported as queued', async () => {
  const f = fixture();
  f.deps.enqueue = async () => null;
  const result = await enqueueCheckoutEventInvoice(f.input, f.deps);
  assert.equal(result.status, 'needs_review');
  assert.equal(result.queued, false);
});

test('both checkout handlers have exactly one durable producer and no competing raw invoice/payment writer', async () => {
  const simpleFile = await readFile(new URL('../functions/[functionName].js', import.meta.url), 'utf8');
  const simple = simpleFile.slice(simpleFile.indexOf('async createOneOffEventBooking('), simpleFile.indexOf('async createOneOffEventBooking(') + 140000);
  const simpleCheckout = simple.slice(0, simple.indexOf('\n  async ', 10));
  const complex = await readFile(new URL('../public/complex-event-booking.js', import.meta.url), 'utf8');
  for (const source of [simpleCheckout, complex]) {
    assert.equal((source.match(/await enqueueCheckoutEventInvoice\(/g) || []).length, 1);
    assert.doesNotMatch(source, /api\.xero\.com\/api\.xro\/2\.0\/(?:Invoices|Payments)/);
    assert.ok(source.indexOf('await enqueueCheckoutEventInvoice(') > source.indexOf('await claimAllocationInvitation('));
    assert.match(source, /invoice_recovery: invoiceRecovery/);
  }
});