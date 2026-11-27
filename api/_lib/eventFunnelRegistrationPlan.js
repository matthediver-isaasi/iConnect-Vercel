import { createHash } from 'node:crypto';
import { FunnelJourneyError, readFunnelJourney, assertFunnelCheckoutSelections } from '../../shared/eventFunnelJourney.mjs';
import { assertFunnelCommercialCompatibility, funnelLineTotal } from './eventFunnelCommercial.js';
import { validateFunnelVoucherAllocations } from './eventFunnelVoucherAllocation.js';

const fail = message => { throw new FunnelJourneyError(message, 'INVALID_REGISTRATION_PLAN', 409); };
const identifier = value => {
  const hex = createHash('sha256').update(JSON.stringify(value)).digest('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
};
const split = (amount, count, index) => Math.floor(amount / count) + (index < amount % count ? 1 : 0);

/** Allocate already-authorized funding, not eligibility or new credit policy. */
export function allocateFunnelAmounts(lines, amount) {
  if (!Number.isSafeInteger(amount) || amount < 0 || !Array.isArray(lines) || !lines.length
    || lines.some(line => !Number.isSafeInteger(line.amountMinor) || line.amountMinor < 0)) fail('Invalid financial allocation.');
  const total = lines.reduce((sum, line) => sum + line.amountMinor, 0);
  if (!Number.isSafeInteger(total) || amount > total) fail('Funding exceeds the selected ticket value.');
  if (!total) return lines.map(() => 0);
  // BigInt avoids rounding errors for large quantities. Stable index breaks
  // ties without changing allocation when a later read returns another order.
  const fractions = lines.map((line, index) => {
    const product = BigInt(line.amountMinor) * BigInt(amount);
    return { index, value: Number(product / BigInt(total)), remainder: product % BigInt(total) };
  });
  let left = amount - fractions.reduce((sum, row) => sum + row.value, 0);
  for (const row of [...fractions].sort((a,b) => a.remainder === b.remainder ? a.index-b.index : a.remainder>b.remainder ? -1 : 1)) {
    if (!left) break;
    row.value++; left--;
  }
  return fractions.map(row => row.value);
}

export function fundedFunnelPaymentMethods(lines) {
  let methods=null;
  for(const line of lines) {
    if(!Number.isSafeInteger(line.payableMinor) || line.payableMinor<0) fail('Invalid payable line.');
    if(!line.payableMinor) continue;
    const permitted=line.priceSnapshot.paymentMethods;
    if(!Array.isArray(permitted)) fail('Payment permissions are missing.');
    methods=methods===null?[...permitted]:methods.filter(method=>permitted.includes(method));
  }
  return methods===null?['free']:methods;
}

/**
 * Pure materialization of validated, held selections. It does not create
 * registrations, redeem credit, call providers, or establish eligibility.
 * IDs and penny allocations remain identical across concurrent preparation.
 */
export function buildFunnelRegistrationPlan(snapshot, {
  paymentMethod, invoiceCustomer, organizationId = null, purchaseOrderNumber = null,
  voucherMinor = 0, trainingFundMinor = 0, voucherAllocations = [], discount = null,
} = {}) {
  const journey = readFunnelJourney(snapshot);
  if (!journey.route.atCheckout || snapshot.session.state !== 'held'
    || Date.parse(snapshot.session.expires_at) <= Date.parse(snapshot.serverNow)) fail('A current reservation at checkout is required.');
  if (!Number.isFinite(Date.parse(snapshot.serverNow)) || !Number.isFinite(Date.parse(snapshot.session.expires_at))) fail('Reservation time could not be verified.');
  assertFunnelCheckoutSelections(journey);
  const compatibility = assertFunnelCommercialCompatibility(snapshot.holds);
  const source = snapshot.holds.find(hold => hold.node_id === snapshot.graph.entry);
  const purchaser = source?.price_snapshot?.purchaser;
  if (!purchaser?.email || !purchaser.first_name || !purchaser.last_name) fail('Original purchaser evidence is missing.');
  if (!invoiceCustomer || typeof invoiceCustomer !== 'object' || Array.isArray(invoiceCustomer)) fail('A verified invoice customer is required.');
  const ordered = [...snapshot.holds].sort((a,b) =>
    journey.route.route.indexOf(a.node_id) - journey.route.route.indexOf(b.node_id) || a.ticket_id.localeCompare(b.ticket_id));
  // A discount code reduces only source (entry) event lines, before funding.
  if (discount !== null && (typeof discount !== 'object' || !discount.discountCodeId || !discount.code
    || !Array.isArray(discount.lines) || !discount.lines.length)) fail('Invalid discount.');
  const discountFor = hold => {
    const parts = (discount?.lines || []).filter(part => part.nodeId === hold.node_id && part.ticketId === hold.ticket_id);
    if (parts.length > 1) fail('Invalid discount.');
    return parts[0]?.discountMinor ?? 0;
  };
  for (const part of discount?.lines || []) {
    if (part.nodeId !== snapshot.graph.entry || !Number.isSafeInteger(part.discountMinor) || part.discountMinor <= 0
      || !ordered.some(hold => hold.node_id === part.nodeId && hold.ticket_id === part.ticketId)) fail('A discount code applies only to the original event purchase.');
  }
  const lines = ordered.map(hold => {
    const listMinor = funnelLineTotal(hold.price_snapshot, hold.quantity), discountMinor = discountFor(hold);
    if (discountMinor > listMinor) fail('A discount cannot exceed the ticket price.');
    return {
      id: identifier([snapshot.session.id,snapshot.session.revision,hold.node_id,hold.ticket_id]),
      nodeId: hold.node_id, ticketId: hold.ticket_id, eventId: hold.event_id, eventKind: hold.event_kind,
      quantity: hold.quantity, places: hold.places, priceSnapshot: structuredClone(hold.price_snapshot),
      listMinor, discountMinor, amountMinor: listMinor - discountMinor,
    };
  });
  const discountMinor = lines.reduce((sum, line) => sum + line.discountMinor, 0);
  if (discount && discount.discountMinor !== undefined && discount.discountMinor !== discountMinor) fail('Invalid discount.');
  const totalMinor = compatibility.totalMinor - discountMinor;
  if (!Number.isSafeInteger(voucherMinor) || voucherMinor < 0 || !Number.isSafeInteger(trainingFundMinor) || trainingFundMinor < 0
    || !Number.isSafeInteger(voucherMinor + trainingFundMinor) || voucherMinor + trainingFundMinor > totalMinor) fail('Invalid funding amount.');
  if (!snapshot.session.member_id && (voucherMinor || trainingFundMinor)) fail('Guest checkout cannot redeem member funding.');
  const payableMinor = totalMinor - voucherMinor - trainingFundMinor;
  const training = allocateFunnelAmounts(lines, trainingFundMinor);
  const vouchers = validateFunnelVoucherAllocations(lines.map((line,index) => ({
    nodeId:line.nodeId,ticketId:line.ticketId,remainingMinor:line.amountMinor-training[index],
  })),voucherAllocations,voucherMinor);
  lines.forEach((line,index)=>{
    line.trainingFundMinor=training[index];line.voucherMinor=vouchers[index];
    line.payableMinor=line.amountMinor-line.trainingFundMinor-line.voucherMinor;
  });
  const paymentMethods=fundedFunnelPaymentMethods(lines);
  if(!paymentMethods.includes(paymentMethod)) fail('The selected payment method is unavailable.');
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex], draft = snapshot.drafts[line.nodeId] || {};
    const attendees = draft.attendeesByTicket?.[line.ticketId] || draft.attendees;
    if (!Array.isArray(attendees) || attendees.length !== line.quantity
      || !Number.isSafeInteger(line.places) || line.places < line.quantity || line.places % line.quantity !== 0) fail('Every purchased ticket needs its original attendee information.');
    line.trainingFundMinor = training[lineIndex]; line.voucherMinor = vouchers[lineIndex];
    line.payableMinor = line.amountMinor - line.trainingFundMinor - line.voucherMinor;
    const purchaseKey = `EF-${snapshot.session.id.replaceAll('-','')}-${snapshot.session.revision}-${line.eventKind[0]}${line.eventId.replaceAll('-','')}`;
    // One allocation pass over attendee gross amounts prevents a funded penny
    // from being assigned to an attendee whose price rounds to zero.
    const attendeeTotals = attendees.map((_, index) => ({ amountMinor: split(line.amountMinor, line.quantity, index) }));
    // split() is monotone in the amount, so each attendee's saving is >= 0.
    const attendeeDiscounts = attendees.map((_, index) => split(line.listMinor, line.quantity, index) - attendeeTotals[index].amountMinor);
    const attendeeTraining = allocateFunnelAmounts(attendeeTotals, line.trainingFundMinor);
    const attendeeVoucher = allocateFunnelAmounts(attendeeTotals.map((row,index) => ({ amountMinor: row.amountMinor-attendeeTraining[index] })), line.voucherMinor);
    line.registrations = attendees.map((attendee, index) => {
      if (!attendee?.email || !attendee.first_name || !attendee.last_name) fail('An attendee name or email is missing.');
      const id = identifier([line.id,index]);
      const gross = attendeeTotals[index].amountMinor;
      const funded = attendeeTraining[index] + attendeeVoucher[index];
      const cash = gross - funded;
      const isCard = paymentMethod === 'card' && cash > 0;
      const saving = attendeeDiscounts[index];
      // Match normal checkout storage: simple total_cost is before the code
      // (saving in discount_code_amount); complex ticket_price is after it.
      const discountColumns = !line.discountMinor ? {} : line.eventKind === 'simple'
        ? { discount_code_id: discount.discountCodeId, discount_code_amount: saving / 100 }
        : { discount_code_id: discount.discountCodeId, discount_code: discount.code, discount_amount: saving / 100 };
      return {
        id, places: line.places / line.quantity, grossMinor: gross, payableMinor: cash, discountMinor: saving,
        voucherMinor: attendeeVoucher[index], trainingFundMinor: attendeeTraining[index],
        row: {
          id, tenant_id: snapshot.session.tenant_id, event_id: line.eventId,
          member_id: snapshot.session.member_id || null, organization_id: organizationId,
          booking_reference: `EF-${id.replaceAll('-','').slice(0,24)}`, booking_group_reference: purchaseKey,
          attendee_email: attendee.email, attendee_first_name: attendee.first_name, attendee_last_name: attendee.last_name,
          attendee_phone: attendee.phone || null, attendee_job_title: attendee.job_title || null,
          ...(line.eventKind === 'simple' ? { is_one_off_event: true, is_guest_booking: !snapshot.session.member_id,
            guest_organisation_name: attendee.organization || null, total_cost: (gross + saving) / 100, account_amount: paymentMethod === 'account' ? cash / 100 : 0 }
            : { attendee_organization: attendee.organization || null, currency: compatibility.currency.toLowerCase(),
              payment_status: isCard || (cash === 0 && funded > 0) ? 'paid' : cash ? 'pending' : 'free', total_paid: isCard ? cash / 100 : 0, account_balance_amount: 0 }),
          status: 'confirmed', payment_method: cash ? paymentMethod : attendeeVoucher[index] > 0 ? 'voucher' : attendeeTraining[index] > 0 ? 'training_fund' : 'free',
          ticket_class_id: line.ticketId === 'default' && line.eventKind === 'simple' ? null : line.ticketId,
          ticket_class_name: line.priceSnapshot.ticketName || 'Admission',
          ticket_price: (line.eventKind === 'simple' ? gross + saving : gross) / 100, ...discountColumns,
          voucher_amount: attendeeVoucher[index] / 100, training_fund_amount: attendeeTraining[index] / 100,
          purchase_order_number: purchaseOrderNumber || null,
          third_party_consent: typeof draft.third_party_consent === 'boolean' ? draft.third_party_consent : null,
          dietary_selections: attendee.dietary_selections || null, allergy_selections: attendee.allergy_selections || null,
          accessibility_selections: attendee.accessibility_selections || null,
        },
      };
    });
  }
  // Freeze each original voucher's contribution to each registration before
  // payment. Refunds must not choose a different voucher after expiry or edits.
  for(const line of lines) {
    const remaining=line.registrations.map(row=>row.voucherMinor);
    for(const row of line.registrations)row.voucherContributions=[];
    for(const allocation of voucherAllocations) {
      const part=allocation.lines.find(part=>part.nodeId===line.nodeId&&part.ticketId===line.ticketId);
      if(!part?.amountMinor)continue;
      const shares=allocateFunnelAmounts(remaining.map(amountMinor=>({amountMinor})),part.amountMinor);
      shares.forEach((amountMinor,index)=>{
        if(amountMinor)line.registrations[index].voucherContributions.push({voucherId:allocation.voucherId,amountMinor});
        remaining[index]-=amountMinor;
      });
    }
    if(remaining.some(amount=>amount!==0))fail('Voucher registration evidence does not balance.');
  }
  const positive = lines.find(line => line.payableMinor > 0);
  return {
    version: 1, voucherAttributionVersion: 1, submissionAccepted: true, purchaser: structuredClone(purchaser),
    invoiceCustomer: structuredClone(invoiceCustomer), invoiceMode: snapshot.graph.invoiceMode,
    invoiceDate: new Date(snapshot.serverNow).toISOString().slice(0,10),
    purchaseOrderNumber: purchaseOrderNumber || null,
    paymentMethod, paymentMethods, paymentAuthority: structuredClone(positive?.priceSnapshot.commercial?.stripe || null),
    currency: compatibility.currency, payableMinor, voucherMinor, discountMinor,
    discounts: discount ? [{ discountCodeId: discount.discountCodeId, code: discount.code, type: discount.type,
      value: discount.value, discountMinor, lines: lines.filter(line => line.discountMinor > 0)
        .map(line => ({ nodeId: line.nodeId, ticketId: line.ticketId, discountMinor: line.discountMinor })) }] : [], voucherAllocations:structuredClone(voucherAllocations), trainingFundMinor, lines,
  };
}
