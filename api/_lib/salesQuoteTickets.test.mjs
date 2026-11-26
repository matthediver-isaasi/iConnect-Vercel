import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { freezeQuoteTicketProduct, prepareQuoteDraft } from './salesQuote.js';
import { normaliseQuoteInput, validateQuoteDraft } from '../../shared/salesContracts.js';

const tenant = '123e4567-e89b-42d3-a456-426614174000';
const eventId = '123e4567-e89b-42d3-a456-426614174001';
const ticketId = '123e4567-e89b-42d3-a456-426614174002';
const productId = '123e4567-e89b-42d3-a456-426614174003';
const ticketTerms = { name: 'Team pass', price: 120, vat_rate_key: 'OUTPUT2', vat_rate_percentage: 20 };
const noProvider = { getActiveAccountingProvider: async () => 'none' };
const xero = { getActiveAccountingProvider: async () => 'xero' };
function database(kind, groupSize = 1, terms = ticketTerms) {
  const product = { id: productId, is_active: true, currency: 'GBP', standard_price_minor: 10000, tax_rate_bps: 0 };
  const rows = {
    sales_settings: { default_terms: '' }, sales_catalogue_product: product,
    system_settings: { setting_value: { provider: 'xero', rates: [
      { taxType: 'OUTPUT2', name: 'Standard 20%', effectiveRate: 20, status: 'ACTIVE', canApplyToRevenue: true },
      { taxType: 'ZERO', name: 'Zero rated', effectiveRate: 0, status: 'ACTIVE', canApplyToRevenue: true },
    ] } },
    [kind === 'simple' ? 'event' : 'complex_event']: { id: eventId, tenant_id: tenant, title: 'Learning forum',
      pricing_config: { ticket_classes: [{ id: ticketId, ...terms, is_group_ticket: groupSize > 1, group_size: groupSize }] } },
    complex_event_ticket_class: { id: ticketId, tenant_id: tenant, complex_event_id: eventId, ...terms,
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
  test(`${kind}: direct tickets need no catalogue product and take price, VAT and description from the ticket`, async () => {
    const db=database(kind,3);
    const draft={currency:'GBP',lines:[{kind:'ticket',quantity:'2',standardUnitPriceMinor:1,description:'Typed by browser',
      taxRateBps:0,eventReference:{kind,eventId,ticketTypeId:ticketId}}]};
    assert.equal(validateQuoteDraft(draft).ok,true);
    const {standardUnitPriceMinor,...withoutPrice}=draft.lines[0];
    assert.equal(validateQuoteDraft({...draft,lines:[withoutPrice]}).ok,true,'ticket lines need no browser price');
    const prepared=await prepareQuoteDraft(db,tenant,{actorId:tenant},draft,false,new Map(),undefined,undefined,undefined,noProvider);
    const line=prepared.lines[0];
    assert.equal(line.catalogueId,null);
    assert.equal(line.catalogueSnapshot.component_kind,'ticket');
    assert.equal(line.quantity*line.catalogueSnapshot.capacity_metadata.delegate_capacity,6);
    assert.equal(line.description,'Learning forum — Team pass');
    assert.equal(line.standardUnitPriceMinor,10000,'£120 VAT-inclusive at 20% is £100 net');
    assert.equal(line.quotedUnitPriceMinor,10000);
    assert.equal(line.taxRateBps,2000);
    assert.equal(line.grossMinor,24000);
    for(const quantity of ['0','1.5','-1']) assert.equal(validateQuoteDraft({...draft,lines:[{...draft.lines[0],quantity}]}).ok,false);
    assert.equal(validateQuoteDraft({...draft,lines:[{...draft.lines[0],eventReference:null}]}).ok,false);
  });
  test(`${kind}: ticket VAT maps to a synced provider code, otherwise an explicit code is required`, async () => {
    const draft={currency:'GBP',lines:[{kind:'ticket',quantity:'1',eventReference:{kind,eventId,ticketTypeId:ticketId}}]};
    const mapped=await prepareQuoteDraft(database(kind),tenant,{actorId:tenant},
      {...draft,lines:[{...draft.lines[0],taxCode:{provider:'xero',id:'ZERO'}}]},false,new Map(),undefined,undefined,undefined,xero);
    assert.deepEqual(mapped.lines[0].catalogueSnapshot.tax_code,{provider:'xero',id:'OUTPUT2',name:'Standard 20%',rateBps:2000},'ticket VAT wins over browser choice');
    const unmatched=database(kind,1,{...ticketTerms,vat_rate_key:'LEGACY'});
    await assert.rejects(prepareQuoteDraft(unmatched,tenant,{actorId:tenant},draft,false,new Map(),undefined,undefined,undefined,xero),/Choose a provider VAT code/);
    const chosen=await prepareQuoteDraft(unmatched,tenant,{actorId:tenant},
      {...draft,lines:[{...draft.lines[0],taxCode:{provider:'xero',id:'ZERO'}}]},false,new Map(),undefined,undefined,undefined,xero);
    assert.equal(chosen.lines[0].taxRateBps,0);
    assert.equal(chosen.lines[0].standardUnitPriceMinor,10000,'net price still uses the ticket VAT rate');
    await assert.rejects(prepareQuoteDraft(database(kind),tenant,{actorId:tenant},{...draft,currency:'EUR'},false,new Map(),undefined,undefined,undefined,noProvider),/priced in GBP/);
  });
  test(`${kind}: early bird price applies and quoted price changes need override permission`, async () => {
    const db=database(kind,1,{...ticketTerms,early_bird_enabled:true,early_bird_price:60,early_bird_deadline:new Date(Date.now()+86400000).toISOString()});
    const line={kind:'ticket',quantity:'1',eventReference:{kind,eventId,ticketTypeId:ticketId}};
    const prepared=await prepareQuoteDraft(db,tenant,{actorId:tenant},{currency:'GBP',lines:[line]},false,new Map(),undefined,undefined,undefined,noProvider);
    assert.equal(prepared.lines[0].standardUnitPriceMinor,5000);
    await assert.rejects(prepareQuoteDraft(db,tenant,{actorId:tenant},{currency:'GBP',lines:[{...line,quotedUnitPriceMinor:4000}]},false,new Map(),undefined,undefined,undefined,noProvider),error=>error.status===403);
    const overridden=await prepareQuoteDraft(db,tenant,{actorId:tenant},{currency:'GBP',lines:[{...line,quotedUnitPriceMinor:4000,discountBps:1000}]},true,new Map(),undefined,undefined,undefined,noProvider);
    assert.equal(overridden.lines[0].quotedUnitPriceMinor,4000);
    assert.equal(overridden.lines[0].priceOverridden,true);
  });
  test(`${kind}: an unchanged saved ticket line keeps its description, price and tax`, async () => {
    const db=database(kind);
    const reference={kind,eventId,ticketTypeId:ticketId};
    const snapshot=await freezeQuoteTicketProduct(db,tenant,{name:'Old words',component_kind:'ticket',standard_price_minor:7000},reference,'1');
    const previous=new Map([['saved',{catalogue_kind:'ticket',catalogue_id:null,description:'Old words',standard_unit_price_minor:7000,
      tax_rate_bps:500,catalogue_snapshot:{...snapshot,tax_code:null}}]]);
    db.rpc=async()=>{throw new Error('This event has already started');};
    const result=await prepareQuoteDraft(db,tenant,{actorId:tenant},{currency:'GBP',lines:[{id:'saved',kind:'ticket',quantity:'3',
      description:'Ignored',eventReference:reference}]},false,previous,undefined,undefined,undefined,noProvider);
    assert.equal(result.lines[0].description,'Old words');
    assert.equal(result.lines[0].standardUnitPriceMinor,7000);
    assert.equal(result.lines[0].taxRateBps,500);
  });
  test(`${kind}: resaving an unchanged mapped ticket cannot swap its VAT code, but an unmatched ticket can`, async () => {
    const reference={kind,eventId,ticketTypeId:ticketId};
    const savedTax={provider:'xero',id:'OUTPUT2',name:'Standard 20%',rateBps:2000};
    const resave=async(db,allowOverride)=>{
      const snapshot=await freezeQuoteTicketProduct(db,tenant,{name:'Learning forum — Team pass',component_kind:'ticket',standard_price_minor:10000},reference,'1');
      const previous=new Map([['saved',{catalogue_kind:'ticket',catalogue_id:null,description:'Learning forum — Team pass',standard_unit_price_minor:10000,
        tax_rate_bps:2000,catalogue_snapshot:{...snapshot,tax_code:savedTax}}]]);
      return prepareQuoteDraft(db,tenant,{actorId:tenant},{currency:'GBP',lines:[{id:'saved',kind:'ticket',quantity:'1',
        eventReference:reference,taxCode:{provider:'xero',id:'ZERO'}}]},allowOverride,previous,undefined,undefined,undefined,xero);
    };
    for (const allowOverride of [false,true]) {
      const kept=await resave(database(kind),allowOverride);
      assert.equal(kept.lines[0].taxRateBps,2000,'mapped ticket VAT is server-owned');
      assert.deepEqual(kept.lines[0].catalogueSnapshot.tax_code,savedTax);
      assert.equal(kept.lines[0].taxMinor,2000);
    }
    const fallback=await resave(database(kind,1,{...ticketTerms,vat_rate_key:'LEGACY'}),false);
    assert.equal(fallback.lines[0].taxRateBps,0,'unmatched ticket VAT accepts the provider code fallback');
    assert.equal(fallback.lines[0].catalogueSnapshot.tax_code.id,'ZERO');
  });
  test(`${kind}: product lines inherit the catalogue ticket link and reject a different proposal ticket`, async () => {
    const db = database(kind);
    const eventReference = { kind, eventId, ticketTypeId: ticketId };
    const draft = { currency: 'GBP', lines: [{ kind: 'product', catalogueId: productId,
      quantity: '4', quotedUnitPriceMinor: 10000, eventReference }] };
    assert.equal(validateQuoteDraft(draft).ok, true);
    assert.deepEqual(normaliseQuoteInput(draft).lines[0].eventReference, eventReference);
    await assert.rejects(prepareQuoteDraft(db, tenant, { actorId: tenant }, draft), /must match the catalogue product/);
    Object.assign(db.product, { event_reference_kind: kind, event_id: eventId, ticket_type_id: ticketId });
    const { eventReference: _omitted, ...inherits } = draft.lines[0];
    const result = await prepareQuoteDraft(db, tenant, { actorId: tenant }, { ...draft, lines: [inherits] });
    assert.equal(result.lines[0].grossMinor, 40000);
    assert.equal(result.lines[0].quantity * result.lines[0].catalogueSnapshot.capacity_metadata.delegate_capacity, 4);
    assert.equal(result.lines[0].catalogueSnapshot.event_id, eventId);
    await assert.rejects(prepareQuoteDraft(db, tenant, { actorId: tenant }, { ...draft, lines: [{ ...inherits, eventReference: null }] }),
      /must match the catalogue product/, 'the catalogue link cannot be removed on the proposal');
  });
  test(`${kind}: an unchanged legacy proposal-local product ticket is still accepted`, async () => {
    const db = database(kind);
    const eventReference = { kind, eventId, ticketTypeId: ticketId };
    const saved = await freezeQuoteTicketProduct(db, tenant, db.product, eventReference, '4');
    const previous = new Map([['saved', { catalogue_kind: 'product', catalogue_id: productId, quantity: '4',
      tax_rate_bps: 0, catalogue_snapshot: saved }]]);
    const line = { id: 'saved', kind: 'product', catalogueId: productId, quantity: '4', quotedUnitPriceMinor: 10000 };
    for (const variant of [line, { ...line, eventReference }]) {
      const result = await prepareQuoteDraft(db, tenant, { actorId: tenant }, { currency: 'GBP', lines: [variant] }, false, previous);
      assert.equal(result.lines[0].catalogueSnapshot.event_id, eventId);
    }
    assert.equal(db.product.event_id, undefined, 'catalogue product is untouched');
    await assert.rejects(prepareQuoteDraft(db, tenant, { actorId: tenant }, { currency: 'GBP',
      lines: [{ ...line, eventReference: { ...eventReference, ticketTypeId: '123e4567-e89b-42d3-a456-426614174009' } }] }, false, previous),
    /must match the catalogue product/);
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
