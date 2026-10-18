import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { freezeQuoteTicketProduct, prepareQuoteDraft } from './salesQuote.js';
import { normaliseQuoteInput, validateQuoteDraft } from '../../shared/salesContracts.js';

const tenant = '123e4567-e89b-42d3-a456-426614174000';
const eventId = '123e4567-e89b-42d3-a456-426614174001';
const ticketId = '123e4567-e89b-42d3-a456-426614174002';
const productId = '123e4567-e89b-42d3-a456-426614174003';
function database(kind, groupSize = 1) {
  const product = { id: productId, is_active: true, currency: 'GBP', standard_price_minor: 10000, tax_rate_bps: 0 };
  const rows = {
    sales_settings: { default_terms: '' }, sales_catalogue_product: product,
    [kind === 'simple' ? 'event' : 'complex_event']: { id: eventId, tenant_id: tenant,
      pricing_config: { ticket_classes: [{ id: ticketId, is_group_ticket: groupSize > 1, group_size: groupSize }] } },
    complex_event_ticket_class: { id: ticketId, tenant_id: tenant, complex_event_id: eventId,
      is_group_ticket: groupSize > 1, group_size: groupSize },
  };
  return { product, from(table) {
    const filters = [];
    return { select() { return this; }, eq(key, value) { filters.push([key, value]); return this; },
      async maybeSingle() {
        const row = rows[table];
        return { data: row && filters.every(([key, value]) => row[key] === undefined || row[key] === value) ? row : null };
      } };
  } };
}
for (const kind of ['simple', 'complex']) {
  test(`${kind}: ordinary product with proposal-local ticket overrides snapshots four £100 tickets as four places`, async () => {
    const db = database(kind);
    const eventReference = { kind, eventId, ticketTypeId: ticketId };
    const draft = { currency: 'GBP', lines: [{ kind: 'product', catalogueId: productId,
      quantity: '4', quotedUnitPriceMinor: 10000, eventReference }] };
    assert.equal(validateQuoteDraft(draft).ok, true);
    assert.deepEqual(normaliseQuoteInput(draft).lines[0].eventReference, eventReference);
    const result = await prepareQuoteDraft(db, tenant, { actorId: tenant }, draft);
    assert.equal(result.lines[0].grossMinor, 40000);
    assert.equal(result.lines[0].quantity * result.lines[0].catalogueSnapshot.capacity_metadata.delegate_capacity, 4);
    assert.equal(result.lines[0].catalogueSnapshot.event_id, eventId);
    assert.equal(db.product.event_id, undefined, 'catalogue product is untouched');
  });
  test(`${kind}: group multiplier freezes and tenant/event mismatches are rejected`, async () => {
    const ref = { kind, eventId, ticketTypeId: ticketId };
    const db = database(kind, 5);
    const snapshot = await freezeQuoteTicketProduct(db, tenant, db.product, ref, '4');
    assert.equal(snapshot.capacity_metadata.delegate_capacity, 5);
    const changed = database(kind, 10);
    const resaved = await freezeQuoteTicketProduct(changed, tenant, changed.product, ref, '4', snapshot);
    assert.equal(resaved.capacity_metadata.delegate_capacity, 5);
    await assert.rejects(freezeQuoteTicketProduct(db, productId, db.product, ref, '4'), /tenant/);
    await assert.rejects(freezeQuoteTicketProduct(db, tenant, db.product, { ...ref, ticketTypeId: productId }, '4'), /Ticket/);
    await assert.rejects(freezeQuoteTicketProduct(db, tenant, db.product, ref, '1.5'), /whole number/);
  });
}
test('header event metadata never allocates unrelated product lines; explicit null removes default', async () => {
  const db = database('simple');
  const prepared = await prepareQuoteDraft(db, tenant, { actorId: tenant }, {
    currency: 'GBP', event: { id: eventId, kind: 'simple' },
    lines: [{ kind: 'product', catalogueId: productId, quantity: '4', quotedUnitPriceMinor: 10000 }],
  });
  assert.equal(prepared.lines[0].catalogueSnapshot.event_id, null);
  const cleared = await freezeQuoteTicketProduct(db, tenant, { ...db.product, event_id: eventId }, null, 4);
  assert.equal(cleared.event_id, null);
});
test('acceptance migration replaces live catalogue candidate identities and requires frozen capacity', () => {
  const sql = readFileSync(new URL('../../supabase/migrations/202610180007_sales_quote_line_ticket_snapshot.sql', import.meta.url), 'utf8');
  assert.match(sql, /l\.catalogue_snapshot->>'event_reference_kind'/);
  assert.match(sql, /c\.product_snapshot->>'event_reference_kind'/);
  assert.match(sql, /capacity_metadata'->>'delegate_capacity'/);
  assert.match(sql, /amend this proposal before acceptance/);
});
