import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import Module from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const require = Module.createRequire(import.meta.url);
const { QueryClient, QueryClientProvider } = require('@tanstack/react-query');
const built = await build({ entryPoints: ['client/src/components/ActivityCreditNoteActions.jsx'],
  bundle: true, platform: 'node', format: 'cjs', write: false, external: ['react', '@tanstack/react-query'] });
const module = { exports: {} };
new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, module, module.exports);
const Component = module.exports.default;
const booking = { id: 'one', booking_group_reference: 'group & one', xero_credit_note_id: 'credit',
  xero_credit_note_number: 'CN-123', xero_invoice_number: 'INV-123', ticket_price: 100 };
function html(b = booking, source = 'simple', data = { amount_minor: 20000, currency: 'GBP' }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['activity-credit-note', 'tenant', source, b.id, b.accounting_credit_note_id || b.xero_credit_note_id], data);
  try { return renderToStaticMarkup(React.createElement(QueryClientProvider, { client },
    React.createElement(Component, { booking: b, source, tenantId: 'tenant' }))); }
  finally { client.clear(); }
}
test('clearly displays credit, number, total and invoice without claiming a refund', () => {
  const output = html();
  for (const text of ['Credit note raised: CN-123', 'Credit note total: £200.00', 'For invoice: INV-123', 'View credit note', 'Download credit note']) assert.ok(output.includes(text));
  assert.ok(!output.includes('refunded'));
  assert.match(output, /group%20%26%20one/);
  assert.match(output, /bookingId=one&amp;source=booking/);
});
test('complex bookings request their exact source', () => {
  assert.match(html(booking, 'complex'), /source=complex_event_booking/);
});
test('cancelled bookings without credit linkage do not claim credit was raised', () => {
  assert.equal(html({ id: 'none', status: 'cancelled' }), '');
});
test('missing amounts do not fabricate the ticket price as a credit', () => {
  const output = html(booking, 'simple', { amount_minor: null, currency: null });
  assert.match(output, /Amount not recorded locally/); assert.ok(!output.includes('£100'));
});
test('missing reference explains why PDF is unavailable', () => {
  const output = html({ ...booking, booking_group_reference: null });
  assert.match(output, /booking reference is missing/); assert.ok(!output.includes('href='));
});
