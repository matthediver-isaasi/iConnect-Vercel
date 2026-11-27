import { FunnelJourneyError, readFunnelJourney, assertFunnelCheckoutSelections } from '../../shared/eventFunnelJourney.mjs';
import { createHash } from 'node:crypto';
import { INVOICING_ADDRESS_KEYS } from '../../shared/invoicingAddress.js';
import { createEventFunnelJourneyService } from './eventFunnelJourney.js';
import { buildFunnelRegistrationPlan,allocateFunnelAmounts } from './eventFunnelRegistrationPlan.js';
import { assertFunnelCommercialCompatibility,funnelLineTotal } from './eventFunnelCommercial.js';
import { quoteEventFunnelVouchers } from './eventFunnelVoucherQuote.js';
import { normalizeFunnelDiscountCode, quoteFunnelDiscount } from './eventFunnelDiscount.js';
import { resolveFunnelMemberships, publicMemberships } from './eventFunnelMembership.js';
import { resolveUnifiedBookingCustomer, bindUnifiedBookingCustomer, unifiedBookingChoices } from './unifiedBookingContract.js';

const fail = (message,code='CHECKOUT_UNAVAILABLE',status=409) => { throw new FunnelJourneyError(message,code,status); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const allowed = new Set(['expectedRevision','paymentMethod','customer','purchaseOrderNumber','submissionAccepted','trainingFundMinor','voucherIds','expectedPayableMinor','discountCode']);
function publicQuote(plan,revision) {
  return {revision,currency:plan.currency,payableMinor:plan.payableMinor,
    trainingFundMinor:plan.trainingFundMinor,voucherMinor:plan.voucherMinor,
    discountMinor:plan.discountMinor,discountCode:plan.discounts[0]?.code || null,
    paymentMethod:plan.paymentMethod,paymentMethods:plan.paymentMethods,invoiceMode:plan.invoiceMode,
    lines:plan.lines.map(line=>({nodeId:line.nodeId,ticketId:line.ticketId,eventId:line.eventId,eventKind:line.eventKind,
      quantity:line.quantity,listMinor:line.listMinor,discountMinor:line.discountMinor,amountMinor:line.amountMinor,payableMinor:line.payableMinor,
      trainingFundMinor:line.trainingFundMinor,voucherMinor:line.voucherMinor})),
    memberships:publicMemberships(plan.memberships)};
}
function submissionKey(command) {
  const customer = command.customer;
  return createHash('sha256').update(JSON.stringify({
    revision:command.expectedRevision,method:command.paymentMethod,
    training:command.trainingFundMinor || 0,
    discount:normalizeFunnelDiscountCode(command.discountCode)?.toUpperCase() || null,
    expectedPayableMinor:command.expectedPayableMinor ?? null,
    vouchers:[...(command.voucherIds || [])].sort(),
    po:command.purchaseOrderNumber?.trim() || null,
    customer:customer ? {kind:customer.kind,id:customer.id,
      address:customer.address ? INVOICING_ADDRESS_KEYS.map(key=>[key,customer.address[key] ?? null]) : null} : null,
  })).digest('hex');
}

/**
 * Internal checkout orchestration. The HTTP layer supplies verified ownership;
 * none of the pricing, purchaser, provider or registration fields come from it.
 * Funding remains fail-closed until reservation adapters are installed.
 */
export function createFunnelCheckoutService({ db, resolveSelection,
  resolveCustomer = resolveUnifiedBookingCustomer, loadChoices = unifiedBookingChoices,quoteVouchers=quoteEventFunnelVouchers }) {
  if (typeof resolveSelection !== 'function') throw new Error('A verified event eligibility resolver is required');
  const journeyService = createEventFunnelJourneyService({ db });
  async function trainingQuote(owner) {
    const ready=await db.rpc('event_funnel_training_ready');
    if(ready.error || typeof ready.data!=='boolean') fail('Training fund availability could not be verified.','FUNDING_UNAVAILABLE',503);
    if(!ready.data) return {enabled:false};
    const quote=await db.rpc('event_funnel_training_quote',{p_tenant:owner.tenantId,p_id:owner.sessionId,
      p_member:owner.memberId || null,p_capability_hash:owner.capabilityHash || null});
    if(quote.error || !object(quote.data) || typeof quote.data.enabled!=='boolean'
      || quote.data.enabled && (!Number.isSafeInteger(quote.data.availableMinor) || quote.data.availableMinor<0)) {
      fail('Training fund availability could not be verified.','FUNDING_UNAVAILABLE',503);
    }
    return quote.data;
  }
  // Fail closed: codes are offered only once the database validates them at
  // order preparation and counts usage on confirmation.
  async function discountReady() {
    try {
      const ready=await db.rpc('event_funnel_discount_ready');
      return !ready.error && ready.data===true;
    } catch { return false; }
  }
  async function discountQuote(owner,snapshot,code) {
    if(!await discountReady()) fail('Discount codes are not available for this booking.','DISCOUNT_UNAVAILABLE',503);
    return quoteFunnelDiscount({db,tenantId:owner.tenantId,snapshot,code});
  }
  async function readOrder(owner) {
    const result = await db.rpc('event_funnel_session_order',{p_tenant:owner.tenantId,p_id:owner.sessionId,
      p_member:owner.memberId || null,p_capability_hash:owner.capabilityHash || null});
    if (result.error) fail('The original checkout could not be loaded. Do not pay again.','CHECKOUT_UNAVAILABLE',503);
    return result.data;
  }
  const service = {
    readOrder,
    async quote(owner,command) {
      if(!object(command)) fail('Invalid checkout quote.','INVALID_CHECKOUT',400);
      return service.prepare(owner,{...command,submissionAccepted:true},true);
    },
    // Inline Apply check. The quote and preparation re-validate independently.
    async discount(owner,command) {
      if(!object(command) || Object.keys(command).some(key=>!['expectedRevision','discountCode'].includes(key))
        || !Number.isSafeInteger(command.expectedRevision) || !normalizeFunnelDiscountCode(command.discountCode)) {
        fail('Enter a discount code.','INVALID_CHECKOUT',400);
      }
      const snapshot = await journeyService.read(owner);
      if (snapshot.session.state !== 'held' || snapshot.session.revision !== command.expectedRevision) {
        fail('Your checkout changed. Review your basket before applying a code.','REVISION_CONFLICT');
      }
      const result=await discountQuote(owner,snapshot,normalizeFunnelDiscountCode(command.discountCode));
      return {revision:snapshot.session.revision,code:result.code,discountMinor:result.discountMinor,lines:result.lines};
    },
    async summary(owner) {
      const snapshot = await journeyService.read(owner);
      const terms = assertFunnelCommercialCompatibility(snapshot.holds);
      const choices = await loadChoices(db,owner.tenantId,snapshot.session.member_id || null);
      const order = await readOrder(owner);
      const training=await trainingQuote(owner);
      const discounts=await discountReady();
      return { ...terms, revision: snapshot.session.revision, expiresAt: snapshot.session.expires_at,
        serverNow: snapshot.serverNow, atCheckout: snapshot.route.atCheckout,
        // Provider contact bindings are private server authority.
        customers: choices.choices.map(({ bindings, ...choice }) => choice),
        personalAddress: choices.personalAddress || null, incomplete: choices.incomplete === true,
        memberFunding:!!snapshot.session.member_id,discountCodes:{enabled:discounts},
        trainingFund:training.enabled ? {enabled:true,availableMinor:training.availableMinor} : {enabled:false},
        order: order ? { id:order.id,state:order.state,paymentMethod:order.payment_method,
          currency:order.currency,payableMinor:order.payable_minor } : null,
        lines: snapshot.holds.map(hold => {
          // Display only: held ticket prices are VAT-inclusive. The quote
          // remains the sole authority for funding and the amount payable.
          const amountMinor = funnelLineTotal(hold.price_snapshot, hold.quantity);
          const rate = Number(hold.price_snapshot.tax?.percentage);
          const taxPercentage = Number.isFinite(rate) && rate > 0 ? rate : null;
          return { nodeId: hold.node_id, ticketId: hold.ticket_id, quantity: hold.quantity,
            eventTitle: hold.price_snapshot.eventTitle, ticketName: hold.price_snapshot.ticketName,
            unitMinor: hold.price_snapshot.unitMinor, amountMinor, taxPercentage,
            includedTaxMinor: taxPercentage ? Math.round(amountMinor * taxPercentage / (100 + taxPercentage)) : 0 };
        }) };
    },
    async prepare(owner, command, quoteOnly=false) {
      if (!object(command) || Object.keys(command).some(key => !allowed.has(key))
        || !Number.isSafeInteger(command.expectedRevision) || command.submissionAccepted !== true
        || !['card','account','public_invoice_po','free'].includes(command.paymentMethod)
        || command.expectedPayableMinor != null && (!Number.isSafeInteger(command.expectedPayableMinor) || command.expectedPayableMinor<0)
        || command.trainingFundMinor != null && (!Number.isSafeInteger(command.trainingFundMinor) || command.trainingFundMinor<0)
        || command.voucherIds != null && (!Array.isArray(command.voucherIds) || command.voucherIds.length>100
          || command.voucherIds.some(id=>typeof id!=='string'||!id) || new Set(command.voucherIds).size!==command.voucherIds.length)
        || normalizeFunnelDiscountCode(command.discountCode) === undefined
        || (command.customer != null && !object(command.customer))
        || (command.purchaseOrderNumber != null && (typeof command.purchaseOrderNumber !== 'string' || command.purchaseOrderNumber.length > 250))) {
        fail('Invalid checkout submission.','INVALID_CHECKOUT',400);
      }
      const snapshot = await journeyService.read(owner);
      const journey = readFunnelJourney(snapshot);
      const requestKey = submissionKey(command);
      if (['payable','payment_uncertain','confirming','confirmed'].includes(snapshot.session.state)) {
        const existing = await readOrder(owner);
        if(quoteOnly) fail('Resume the existing checkout instead of requesting another quote.','REVISION_CONFLICT');
        if (existing?.snapshot?.submissionKey === requestKey) return existing;
        fail('Resume the original checkout. Its payment instructions cannot be changed.','REVISION_CONFLICT');
      }
      if (snapshot.session.state !== 'held' || !journey.route.atCheckout
        || snapshot.session.revision !== command.expectedRevision) {
        fail('Your checkout changed. Resume the original reservation without paying again.','REVISION_CONFLICT');
      }
      assertFunnelCheckoutSelections(journey);
      const normalized = structuredClone(snapshot);
      // Revalidate every purchase, including previously accepted optional offers,
      // without replacing held economics or acquiring any extra inventory.
      for (const selection of journey.selections.values()) {
        const node = journey.nodes.get(selection.nodeId);
        const result = await resolveSelection({ owner, snapshot, node, tickets: selection.tickets,
          answers: snapshot.drafts[node.id] || {}, previousHolds: snapshot.holds.filter(hold => hold.node_id === node.id),
          selections: [...journey.selections.values()], rereserve: false });
        if (!object(result?.answers) || !Array.isArray(result.lines)) fail('Attendee details could not be verified.');
        const held = snapshot.holds.filter(hold => hold.node_id === node.id);
        if (result.lines.length !== held.length || result.lines.some(line => {
          const original = held.find(hold => hold.ticket_id === line.ticketId);
          return !original || JSON.stringify(original.price_snapshot) !== JSON.stringify(line.priceSnapshot);
        })) fail('Held prices changed. Re-reserve before proceeding.','PRICE_CHANGED');
        normalized.drafts[node.id] = result.answers;
      }
      const source = snapshot.holds.find(hold => hold.node_id === snapshot.graph.entry);
      const customer = await resolveCustomer({ db, tenantId: owner.tenantId,requestId: owner.sessionId,
        memberId: snapshot.session.member_id || null,purchaser: source.price_snapshot.purchaser,selection: command.customer });
      const accounting = snapshot.holds.find(hold => hold.price_snapshot.unitMinor > 0)?.price_snapshot.commercial?.accounting
        || source.price_snapshot.commercial?.accounting;
      const contact = bindUnifiedBookingCustomer(customer.contact,customer.selectedBindings,
        accounting?.company ? { name: accounting.name,realmId: accounting.company,xeroTenantId: accounting.company } : null);
      const code=normalizeFunnelDiscountCode(command.discountCode);
      const discount=code ? await discountQuote(owner,normalized,code) : null;
      const discountFor=hold=>discount?.lines.find(line=>line.nodeId===hold.node_id&&line.ticketId===hold.ticket_id)?.discountMinor || 0;
      const training=command.trainingFundMinor ? await trainingQuote(owner) : {enabled:false};
      if(command.trainingFundMinor && (!training.enabled || command.trainingFundMinor>training.availableMinor)) {
        fail('The requested training fund amount is unavailable.','FUNDING_UNAVAILABLE');
      }
      let voucherQuote={voucherMinor:0,allocations:[]};
      if(command.voucherIds?.length) {
        const ready=await db.rpc('event_funnel_voucher_ready');
        if(ready.error || ready.data!==true) fail('Voucher checkout is not available.','FUNDING_UNAVAILABLE',503);
        const holds=[...snapshot.holds].sort((a,b)=>journey.route.route.indexOf(a.node_id)-journey.route.route.indexOf(b.node_id)
          || a.ticket_id.localeCompare(b.ticket_id));
        const gross=holds.map(hold=>({amountMinor:funnelLineTotal(hold.price_snapshot,hold.quantity)-discountFor(hold)}));
        const trainingAmounts=allocateFunnelAmounts(gross,command.trainingFundMinor || 0);
        const lines=holds.map((hold,index)=>({nodeId:hold.node_id,ticketId:hold.ticket_id,
          remainingMinor:gross[index].amountMinor-trainingAmounts[index]}));
        voucherQuote=await quoteVouchers({db,owner,snapshot:normalized,requestedIds:command.voucherIds,lines});
      }
      const netMinor=assertFunnelCommercialCompatibility(normalized.holds).totalMinor-(discount?.discountMinor || 0)
        -(command.trainingFundMinor || 0)-voucherQuote.voucherMinor;
      const plan = buildFunnelRegistrationPlan(normalized,{ paymentMethod: quoteOnly && netMinor===0?'free':command.paymentMethod,invoiceCustomer: contact,
        trainingFundMinor:command.trainingFundMinor || 0,discount,
        voucherMinor:voucherQuote.voucherMinor,voucherAllocations:voucherQuote.allocations,
        purchaseOrderNumber: command.purchaseOrderNumber?.trim() || null,
        organizationId: command.trainingFundMinor ? training.organizationId : contact.provenance?.kind === 'organization' ? contact.provenance.id : null });
      plan.submissionKey = requestKey;
      // Accepted complimentary memberships add no charge; recipient eligibility
      // is checked here, before any payment, and re-verified on confirmation.
      plan.memberships = await resolveFunnelMemberships({ db, tenantId: owner.tenantId, snapshot, route: journey.route, plan });
      if(quoteOnly) return publicQuote(plan,snapshot.session.revision);
      if(command.expectedPayableMinor != null && command.expectedPayableMinor!==plan.payableMinor) {
        fail('The amount changed. Review a fresh quote before confirming.','QUOTE_CHANGED');
      }
      const prepared = await db.rpc('event_funnel_prepare_order',{
        p_tenant: owner.tenantId,p_id: owner.sessionId,p_member: owner.memberId || null,p_capability_hash: owner.capabilityHash || null,
        p_expected_revision: command.expectedRevision,p_snapshot: plan,
      });
      if (prepared.error || !prepared.data) {
        const existing = await readOrder(owner);
        if (existing?.snapshot?.submissionKey === requestKey) return existing;
        fail('Checkout could not be prepared. Resume this reservation without paying again.',
          prepared.error?.code === 'PT409' ? 'REVISION_CONFLICT' : 'CHECKOUT_UNAVAILABLE',prepared.error?.code === 'PT409' ? 409 : 503);
      }
      return prepared.data;
    },
  };
  return service;
}
