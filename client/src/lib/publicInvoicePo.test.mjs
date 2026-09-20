import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isPublicInvoicePoAvailable,
  isPublicInvoicePurchaserComplete,
  normalizePublicInvoicePurchaser,
} from './publicInvoicePo.mjs';

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
  });
  assert.equal(isPublicInvoicePurchaserComplete(purchaser), true);
  assert.equal(isPublicInvoicePurchaserComplete({ first_name: 'Pat', email: 'pat@example.com' }), false);
});