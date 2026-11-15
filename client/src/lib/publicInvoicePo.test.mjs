import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isPublicInvoicePoAvailable,
  isPublicInvoicePurchaserComplete,
  normalizePublicInvoicePurchaser,
} from './publicInvoicePo.mjs';
import { normalizePublicInvoicePoAddress } from '../../../shared/publicInvoicePoAddress.js';

const invoiceAddress = {
  invoicing_address_line1: '21 Beacon Road', invoicing_city: 'Leeds',
  invoicing_postal_code: 'LS1 7AB', invoicing_country: 'United Kingdom',
};

const enabledEvent = { allow_public_invoice_po: true };
const publicTicket = { visibility_mode: 'members_and_public', price: 25 };

test('public Invoice / PO is limited to non-member paid public registrations', () => {
  assert.equal(isPublicInvoicePoAvailable({
    event: enabledEvent,
    isGuestCheckout: true,
    remainingBalance: 25,
    ticket: publicTicket,
  }), true);
  assert.equal(isPublicInvoicePoAvailable({
    event: enabledEvent,
    isGuestCheckout: false,
    remainingBalance: 25,
    ticket: publicTicket,
  }), false);
  assert.equal(isPublicInvoicePoAvailable({
    event: enabledEvent,
    isGuestCheckout: true,
    remainingBalance: 0,
    ticket: publicTicket,
  }), false);
  assert.equal(isPublicInvoicePoAvailable({
    event: enabledEvent,
    isGuestCheckout: true,
    remainingBalance: 25,
    ticket: { visibility_mode: 'members_only' },
  }), false);
  assert.equal(isPublicInvoicePoAvailable({
    event: { allow_public_invoice_po: false },
    isGuestCheckout: true,
    remainingBalance: 25,
    ticket: publicTicket,
  }), false);
});

test('purchaser context is normalized independently from attendee data', () => {
  const purchaser = normalizePublicInvoicePurchaser({
    first_name: '  Pat ',
    last_name: ' Buyer  ',
    email: ' PAT@EXAMPLE.COM ',
    organization: ' Example Ltd ',
  });
  assert.deepEqual(purchaser, {
    first_name: 'Pat',
    last_name: 'Buyer',
    email: 'pat@example.com',
    organization: 'Example Ltd',
    phone: '',
    job_title: '',
    ...normalizePublicInvoicePoAddress({}),
  });
  assert.equal(isPublicInvoicePurchaserComplete(purchaser), false);
  assert.equal(isPublicInvoicePurchaserComplete({ ...purchaser, ...invoiceAddress }), true);
  assert.equal(isPublicInvoicePurchaserComplete({ first_name: 'Pat', email: 'pat@example.com' }), false);
});

test('public invoice requires an organisation and each required address field, not optional region/line2', () => {
  const complete = { first_name: 'Pat', last_name: 'Buyer', email: 'pat@example.com', organization: 'Beacon Trust', ...invoiceAddress };
  assert.equal(isPublicInvoicePurchaserComplete(complete), true);
  for (const key of ['organization', ...Object.keys(invoiceAddress)]) {
    assert.equal(isPublicInvoicePurchaserComplete({ ...complete, [key]: '  ' }), false, key);
  }
});

test('normalization preserves only allowlisted trimmed invoice address fields', () => {
  const normalized = normalizePublicInvoicePurchaser({
    ...invoiceAddress, invoicing_address_line1: ' 21 Beacon Road ', invoicing_address_line2: ' Finance office ',
    invoicing_region: ' Yorkshire ', invoicing_secret: 'private', unrelated: 'private',
  });
  assert.equal(normalized.invoicing_address_line1, invoiceAddress.invoicing_address_line1);
  assert.equal(normalized.invoicing_address_line2, 'Finance office');
  assert.equal(normalized.invoicing_region, 'Yorkshire');
  assert.equal(normalized.invoicing_secret, undefined);
  assert.equal(normalized.unrelated, undefined);
});