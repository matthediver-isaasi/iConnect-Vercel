// Checkout captures evidence; the recovery worker is the only accounting writer.
// No provider calls or credentials belong in a durable snapshot.
const clone = value => JSON.parse(JSON.stringify(value));
const minor = value => Math.round(Number(value) * 100);

function freezeLineTax(line, ticket) {
  const percentage = ticket?.vat_rate_percentage;
  if (line.TaxType && percentage !== null && percentage !== undefined && percentage !== ''
    && Number.isFinite(Number(percentage)) && Number(percentage) >= 0) {
    line.TaxAmount = minor(Number(line.Quantity) * Number(line.UnitAmount) * Number(percentage) / 100) / 100;
  }
  return line;
}

function invoiceContactPayload(contact) {
  if (!contact?.name) return null;
  const payload = { Name: contact.name, ...(contact.email ? { EmailAddress: contact.email } : {}) };
  // Same address mapping as the historical complex-event Xero contact helper.
  const lines = typeof contact.address === 'string' ? contact.address.split('\n').map(l => l.trim()).filter(Boolean) : [];
  if (lines.length) {
    const address = { AddressType: 'POBOX', AddressLine1: lines[0] };
    if (lines.length === 2) address.City = lines[1];
    if (lines.length === 3) { address.City = lines[1]; address.PostalCode = lines[2]; }
    if (lines.length >= 4) {
      address.AddressLine2 = lines[1]; address.City = lines[2]; address.PostalCode = lines[3];
      if (lines[4]) address.Country = lines[4];
    }
    payload.Addresses = [address];
  }
  return payload;
}

export function eventInvoiceContact({ source, org, member, isGuestBooking, guestInfo }) {
  if (org) return {
    name: org.name,
    email: org.invoicing_email || null,
    ...(source === 'complex_event_booking' ? { address: org.address || null } : {}),
    isOrganization: true,
    provenance: { kind: 'organization', id: org.id },
  };
  // Complex checkout never historically identified a guest purchaser. In
  // particular, the first attendee must NOT become the invoice recipient.
  if (source === 'booking' && isGuestBooking && guestInfo) {
    const organization = typeof guestInfo.organization === 'string' ? guestInfo.organization.trim() : null;
    return {
      name: organization || `${guestInfo.first_name || ''} ${guestInfo.last_name || ''}`.trim() || guestInfo.email,
      email: guestInfo.email,
      isOrganization: !!organization,
      provenance: { kind: 'guest_purchaser', guestInfo: {
        first_name: guestInfo.first_name, last_name: guestInfo.last_name,
        email: guestInfo.email, organization: guestInfo.organization,
      } },
    };
  }
  if (member) return {
    name: `${member.first_name || ''} ${member.last_name || ''}`.trim() || member.email,
    email: member.email,
    isOrganization: false,
    provenance: { kind: 'member', id: member.id },
  };
  return null;
}

export function simpleEventInvoiceLines({
  event, bookingAttendees, ticketsRequired, ticketClassName, ticketClassPrice,
  ticketClassId, totalCost, voucherAmountApplied, validatedTrainingFundAmount,
  pricingDetails, validatedRemainingBalance,
}, accountCode) {
  const attendeeList = bookingAttendees.map(a =>
    `${a.first_name || a.firstName || ''} ${a.last_name || a.lastName || ''}`.trim() || a.email
  ).join('\n');
  const ticketUnitPrice = ticketClassPrice || (totalCost / ticketsRequired);
  const breakdown = [`${ticketsRequired} x ${ticketClassName || 'Ticket'} @ £${ticketUnitPrice.toFixed(2)} = £${(ticketUnitPrice * ticketsRequired).toFixed(2)}`];
  if (voucherAmountApplied > 0) breakdown.push(`Voucher applied: -£${voucherAmountApplied.toFixed(2)}`);
  if (validatedTrainingFundAmount > 0) breakdown.push(`Training fund applied: -£${validatedTrainingFundAmount.toFixed(2)}`);
  if (pricingDetails?.freeTickets > 0) breakdown.push(`BOGO offer: ${pricingDetails.freeTickets} free ticket${pricingDetails.freeTickets > 1 ? 's' : ''}`);
  if (pricingDetails?.bulkDiscountAmount > 0) breakdown.push(`Bulk discount: -£${pricingDetails.bulkDiscountAmount.toFixed(2)}`);
  if (pricingDetails?.discountAmount > 0 && !pricingDetails.bulkDiscountAmount) breakdown.push(`Discount applied: -£${pricingDetails.discountAmount.toFixed(2)}`);
  breakdown.push(`Total to invoice: £${validatedRemainingBalance.toFixed(2)}`);
  const line = {
    Description: [
      `Event: ${event.title || 'One-off Event'}`,
      `Reference: ${event.internal_reference || 'N/A'}`,
      `Ticket class: ${ticketClassName || 'Standard'}`,
      `Attendees: ${ticketsRequired}`, attendeeList, '', '----------', 'Financial Breakdown:', ...breakdown,
    ].join('\n'),
    Quantity: 1, UnitAmount: validatedRemainingBalance, AccountCode: accountCode,
  };
  const ticket = event.pricing_config?.ticket_classes?.find(tc => tc.id === ticketClassId);
  if (ticket?.vat_rate_key) line.TaxType = ticket.vat_rate_key;
  if (event.internal_reference) line.Tracking = [{ Name: 'Projects', Option: event.internal_reference }];
  return [freezeLineTax(line, ticket)];
}

export function complexEventInvoiceLines({ event, resolvedItems, actualVoucherApplied, actualTfApplied }, accountCode) {
  const lines = resolvedItems.map(item => {
    const attendees = item.attendees.map(a => `${a.first_name || ''} ${a.last_name || ''}`.trim() || a.email).join(', ');
    const line = {
      Description: [`Event: ${event.title || 'Complex Event'}`, `Ticket: ${item.serverTicket.name || 'Ticket'}`, `Attendees: ${attendees}`].join('\n'),
      Quantity: item.attendees.length, UnitAmount: item.authoritativePrice, AccountCode: accountCode,
    };
    if (item.ticketClass?.vat_rate_key) line.TaxType = item.ticketClass.vat_rate_key;
    if (event.internal_reference) line.Tracking = [{ Name: 'Projects', Option: event.internal_reference }];
    return freezeLineTax(line, item.ticketClass);
  });
  if (actualVoucherApplied > 0) lines.push({ Description: 'Voucher discount', Quantity: 1, UnitAmount: -actualVoucherApplied, AccountCode: accountCode });
  if (actualTfApplied > 0) lines.push({ Description: 'Training fund contribution', Quantity: 1, UnitAmount: -actualTfApplied, AccountCode: accountCode });
  return lines;
}

export function capturedEventSettlement({ paymentIntent, paymentIntentId, amount, currency, accountCode, eventId }) {
  const charge = paymentIntent?.latest_charge;
  if (!paymentIntentId || paymentIntent?.id !== paymentIntentId || paymentIntent.status !== 'succeeded'
    || paymentIntent.metadata?.event_id !== eventId
    || !Number.isSafeInteger(paymentIntent.amount_received) || paymentIntent.amount_received !== minor(amount)
    || paymentIntent.amount !== paymentIntent.amount_received
    || String(paymentIntent.currency || '').toUpperCase() !== currency
    || !charge || typeof charge !== 'object' || charge.status !== 'succeeded'
    || charge.paid !== true || charge.captured !== true || charge.refunded === true
    || Number(charge.amount_refunded || 0) !== 0
    || charge.amount_captured !== paymentIntent.amount_received
    || String(charge.currency || '').toUpperCase() !== currency
    || (charge.payment_intent && charge.payment_intent !== paymentIntentId)
    || !Number.isFinite(charge.created) || charge.created <= 0 || !accountCode) {
    throw new Error('Captured Stripe amount, currency, purchaser payment binding, bank mapping or payment date is missing or inconsistent');
  }
  // PI.created is initiation, not payment time. A charge created at a different
  // time from manual capture is not sufficient evidence of the capture date.
  if (paymentIntent.capture_method === 'manual') throw new Error('Manual capture payment date requires review');
  return {
    paymentIntentId, status: 'succeeded', amount, currency,
    paidAt: new Date(charge.created * 1000).toISOString(), accountCode,
    chargeId: charge.id,
    amountReceived: paymentIntent.amount_received,
    captured: true,
  };
}

async function loadContext(db, tenantId) {
  const settingsResult = await db.from('system_settings')
    .select('setting_key, setting_value').eq('tenant_id', tenantId)
    .in('setting_key', ['xero_invoice_enabled', 'xero_sales_account_code', 'xero_invoice_status', 'xero_stripe_bank_account_code']);
  if (settingsResult.error) throw new Error('Invoice settings could not be snapshotted');
  const settings = Object.fromEntries((settingsResult.data || []).map(row => [row.setting_key, row.setting_value]));
  if (settings.xero_invoice_enabled !== 'true') return { excluded: true };
  const activeResult = await db.from('tenant_accounting_settings').select('active_provider').eq('tenant_id', tenantId).maybeSingle();
  if (activeResult.error && activeResult.error.code !== '42P01') throw new Error('Accounting provider could not be snapshotted');
  if (['none', 'quickbooks'].includes(activeResult.data?.active_provider)) return { excluded: true };
  if (activeResult.data?.active_provider && activeResult.data.active_provider !== 'xero') throw new Error('Unrecognized accounting provider');
  const tokenResult = await db.from('xero_token').select('id, tenant_id').eq('app_tenant_id', tenantId);
  if (tokenResult.error) throw new Error('Xero connection could not be snapshotted');
  const tokens = tokenResult.data || [];
  if (tokens.length !== 1 || !tokens[0].id || !tokens[0].tenant_id || tokens[0].tenant_id === 'PENDING_SELECTION') {
    throw new Error('A unique selected Xero connection is required');
  }
  return { settings, provider: { connectionId: tokens[0].id, xeroTenantId: tokens[0].tenant_id } };
}

/**
 * Must be called only after booking/capacity/credit/allocation commits. Invoice
 * failures never invalidate a confirmed booking. The return value makes an
 * enqueue failure explicit rather than falsely reporting a queued invoice.
 * Injectable enqueue is used by isolated tests, never a second writer.
 */
export async function enqueueCheckoutEventInvoice({
  db, tenantId, source, bookingGroupReference, event, amount, currency,
  paymentMethod, paymentIntentId, paymentIntent, contact, purchaseOrderNumber,
  poToFollow, buildLines, now = new Date(),
}, { enqueue, logger = console } = {}) {
  if (paymentMethod === 'public_invoice_po' || paymentMethod === 'free' || Number(amount) <= 0) {
    return { status: 'not_applicable' };
  }
  const reviewReasons = [];
  let context;
  let snapshot = {
    version: 1, contact: contact ? clone(contact) : null,
    currency: String(currency || '').toUpperCase(), amount: Number(amount),
    paymentMethod: paymentMethod === 'card' ? 'stripe' : 'invoice',
    checkoutPaymentMethod: paymentMethod,
    purchaseOrderNumber: purchaseOrderNumber || null, poToFollow: !!poToFollow,
    settlement: null, provider: null, invoice: null,
  };
  try {
    if (!tenantId || event?.tenant_id !== tenantId) throw new Error('Checkout tenant binding is missing or inconsistent');
    context = await loadContext(db, tenantId);
    if (context.excluded) return { status: 'not_applicable' };
    snapshot.provider = context.provider;
    const accountCode = event.xero_account_code?.trim() || context.settings.xero_sales_account_code || '200';
    const invoiceDate = new Date(now);
    const dueDate = new Date(now);
    dueDate.setDate(dueDate.getDate() + 30);
    snapshot.invoice = {
      Type: 'ACCREC',
      Contact: invoiceContactPayload(contact),
      Date: invoiceDate.toISOString().split('T')[0], DueDate: dueDate.toISOString().split('T')[0],
      CurrencyCode: snapshot.currency,
      // The original API omitted this field; Xero's default is Exclusive.
      // Freeze that historical treatment rather than reading future settings.
      LineAmountTypes: 'Exclusive',
      LineItems: buildLines(accountCode),
      Reference: poToFollow ? 'TBC' : (purchaseOrderNumber || 'TBC'),
      Status: context.settings.xero_invoice_status || 'DRAFT',
    };
    if (!contact?.name || !contact?.provenance) reviewReasons.push('Checkout purchaser provenance is missing');
    if (!Number.isFinite(snapshot.amount) || snapshot.amount <= 0 || !/^[A-Z]{3}$/.test(snapshot.currency)) reviewReasons.push('Checkout amount or currency is invalid');
    if (snapshot.invoice.LineItems.some(line => !line.TaxType || !Number.isFinite(line.TaxAmount))) {
      reviewReasons.push('Historical VAT evidence is missing; current account tax defaults must not be inferred');
    } else {
      const grossMinor = snapshot.invoice.LineItems.reduce((sum, line) =>
        sum + minor(Number(line.Quantity) * Number(line.UnitAmount)) + minor(line.TaxAmount), 0);
      if (grossMinor !== minor(snapshot.amount)) reviewReasons.push('Historical invoice gross total does not match the checkout amount');
    }
    if (paymentMethod === 'card') {
      try {
        snapshot.settlement = capturedEventSettlement({
          paymentIntent, paymentIntentId, amount: snapshot.amount, currency: snapshot.currency,
          accountCode: context.settings.xero_stripe_bank_account_code, eventId: event.id,
        });
      } catch (error) { reviewReasons.push(error.message); }
    } else if (!['account', 'invoice'].includes(paymentMethod)) {
      reviewReasons.push('This payment method requires separate settlement review');
    }
  } catch (error) {
    reviewReasons.push(error.message);
  }
  if (reviewReasons.length) {
    snapshot.reviewReasons = reviewReasons;
    // Fail closed even when an older runner does not understand reviewReasons.
    snapshot.originalInvoice = snapshot.invoice;
    snapshot.invoice = null;
  }
  snapshot = clone(snapshot);
  try {
    const queue = enqueue || (await import('./eventInvoiceRecovery.js')).enqueueEventInvoiceRecovery;
    const row = await queue({ db, tenantId, source, bookingGroupReference, snapshot });
    if (!row || !['pending', 'processing', 'retry', 'complete', 'needs_review', 'not_applicable'].includes(row.status)) {
      throw new Error('Durable enqueue returned no confirmed operation');
    }
    return { status: row.status, queued: true };
  } catch (error) {
    logger.error('[Event invoice recovery] Durable enqueue failed; confirmed booking requires invoice review:', error.message);
    try {
      const marker = await db.from(source).update({ invoice_recovery_status: 'needs_review', invoice_recovery_next_attempt_at: null })
        .eq('tenant_id', tenantId).eq('booking_group_reference', bookingGroupReference);
      if (marker.error) logger.error('[Event invoice recovery] Review marker could not be persisted:', marker.error.message);
    } catch (markerError) {
      logger.error('[Event invoice recovery] Review marker could not be persisted:', markerError.message);
    }
    return { status: 'needs_review', queued: false, warning: 'Booking confirmed, but its invoice could not be queued. Administrator review is required.' };
  }
}