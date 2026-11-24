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
  return { product, async rpc(name) {
    assert.equal(name, 'sales_ticket_event_options');
    return { data: { items: [{ id: eventId, eligible: true, ticketOptions: [{ id: ticketId }] }] } };
  }, from(table) {
    const filters = [];
    return { select() { return this; }, eq(key, value) { filters.push([key, value]); return this; },
      async maybeSingle() {
        const row = rows[table];
        return { data: row && filters.every(([key, value]) => row[key] === undefined || row[key] === value) ? row : null };
      } };
  } };
}
for (const kind of ['simple', 'complex']) {
  test(`${kind}: direct tickets need no catalogue product and preserve group places and commercial price`, async () => {
    const db=database(kind,3);
    const draft={currency:'GBP',lines:[{kind:'ticket',quantity:'2',standardUnitPriceMinor:10000,
      quotedUnitPriceMinor:10000,eventReference:{kind,eventId,ticketTypeId:ticketId}}]};
    assert.equal(validateQuoteDraft(draft).ok,true);
    const prepared=await prepareQuoteDraft(db,tenant,{actorId:tenant},draft);
    assert.equal(prepared.lines[0].catalogueId,null);
    assert.equal(prepared.lines[0].catalogueSnapshot.component_kind,'ticket');
    assert.equal(prepared.lines[0].quantity*prepared.lines[0].catalogueSnapshot.capacity_metadata.delegate_capacity,6);
    assert.equal(prepared.lines[0].grossMinor,20000);
    for(const quantity of ['0','1.5','-1']) assert.equal(validateQuoteDraft({...draft,lines:[{...draft.lines[0],quantity}]}).ok,false);
    assert.equal(validateQuoteDraft({...draft,lines:[{...draft.lines[0],eventReference:null}]}).ok,false);
  });
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

for (const directTicket of [true, false]) {
  test(`unchanged bundle ${directTicket ? 'direct ticket' : 'legacy ticket product'} survives past-event billing edits`, async () => {
    const db = database('simple');
    const componentId = 'component';
    const bundleId = 'bundle';
    const reference = { kind: 'simple', eventId, ticketTypeId: ticketId };
    Object.assign(db.product, { event_reference_kind: 'simple', event_id: eventId, ticket_type_id: ticketId });
    const snapshot = await freezeQuoteTicketProduct(db, tenant, db.product, reference, '1');
    snapshot.billing_component_id = componentId;
    const component = { id: componentId, component_kind: directTicket ? 'ticket' : 'product',
      product_id: directTicket ? null : productId, quantity: '1',
      event_reference_kind: 'simple', event_id: eventId, ticket_type_id: ticketId };
    const originalFrom = db.from;
    db.from = table => {
      if (table === 'sales_catalogue_bundle') return { select() { return this; }, eq() { return this; },
        maybeSingle: async () => ({ data: { id: bundleId, is_active: true, currency: 'GBP', selling_price_minor: 10000, tax_rate_bps: 0 } }) };
      if (table === 'sales_catalogue_bundle_item') return { select() { return this; }, eq() { return this; },
        order: async () => ({ data: [component] }) };
      return originalFrom(table);
    };
    db.rpc = async () => { throw new Error('This event has already started'); };
    const draft = { currency: 'GBP', lines: [{ id: 'saved', kind: 'bundle', catalogueId: bundleId, quantity: '1' }] };
    const prior = { catalogue_kind: 'bundle', catalogue_id: bundleId, quantity: '1', tax_rate_bps: 0,
      catalogue_snapshot: {}, sales_quote_bundle_component: [{
        product_id: component.product_id, quantity: '1', product_snapshot: snapshot,
      }] };
    const previous = new Map([['saved', prior]]);
    const result = await prepareQuoteDraft(db, tenant, { actorId: tenant }, draft, false, previous);
    assert.equal(result.lines[0].components[0].productSnapshot.event_id, eventId);
    assert.equal(result.lines[0].components[0].productSnapshot.capacity_metadata.delegate_capacity, 1);
    await assert.rejects(prepareQuoteDraft(db, tenant, { actorId: tenant }, draft), /already started/);
    await assert.rejects(prepareQuoteDraft(db, tenant, { actorId: tenant },
      { ...draft, lines: [{ ...draft.lines[0], quantity: '2' }] }, false, previous), /already started/);
    component.quantity = '2';
    await assert.rejects(prepareQuoteDraft(db, tenant, { actorId: tenant }, draft, false, previous), /already started/);
  });
}
test('acceptance migration replaces live catalogue candidate identities and requires frozen capacity', () => {
  const sql = readFileSync(new URL('../../supabase/migrations/202610180007_sales_quote_line_ticket_snapshot.sql', import.meta.url), 'utf8');
  assert.match(sql, /l\.catalogue_snapshot->>'event_reference_kind'/);
  assert.match(sql, /c\.product_snapshot->>'event_reference_kind'/);
  assert.match(sql, /capacity_metadata'->>'delegate_capacity'/);
  assert.match(sql, /amend this proposal before acceptance/);
});
