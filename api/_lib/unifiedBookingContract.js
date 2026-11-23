import { createHash } from 'node:crypto';
import { assertStandaloneEventOffer } from './eventFunnelPurchasePolicy.js';
import { INVOICING_ADDRESS_KEYS, resolveStoredInvoicingAddress, invoicingAddressError } from '../../shared/invoicingAddress.js';
import { publicTicketEmailExists } from './publicTicketEmail.js';
import { billingOrganizationIds as resolveBillingOrganizationIds } from './billingOrganizationAffiliations.js';

export const UNIFIED_BOOKING_VERSION = 2;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = (message, statusCode = 409) => { throw Object.assign(new Error(message), { statusCode, code: 'UNIFIED_BOOKING_CONFLICT' }); };
const missing = error => ['42P01', 'PGRST205', 'PGRST202', '42883'].includes(error?.code);
const canonical = value => JSON.stringify(sort(value));
const bindings = row => ({
  xeroId: row.xero_contact_id || null, xeroCompany: row.xero_tenant_id || null,
  quickbooksId: row.quickbooks_customer_id || null, quickbooksCompany: row.quickbooks_realm_id || null,
});
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  return value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])])) : value;
}
export const unifiedBookingKey = (tenantId, source, id) =>
  `B2-${createHash('sha256').update(JSON.stringify([tenantId, source, id])).digest('hex').slice(0, 40)}`;

// Missing schema means legacy; a failed capability read is never activation.
export async function unifiedBookingReady(db) {
  const result = await db.rpc('unified_booking_readiness');
  if (missing(result.error)) return false;
  if (result.error) fail('Unable to verify booking readiness', 503);
  return result.data?.version === 2 && result.data?.enabled === true;
}

export async function unifiedBookingChoices(db, tenantId, memberId) {
  if (!memberId) return { choices: [], personalAddress: null };
  const memberResult = await db.from('member').select('*').eq('tenant_id', tenantId).eq('id', memberId).maybeSingle();
  if (memberResult.error || !memberResult.data) fail('Unable to verify purchasing member', 403);
  const member = memberResult.data;
  let incomplete = false;
  const privateAddress = async (type, id) => {
    const result = await db.from('invoicing_address_private').select(INVOICING_ADDRESS_KEYS.join(','))
      .eq('tenant_id', tenantId).eq('owner_type', type).eq('owner_id', id).maybeSingle();
    if (result.error) { incomplete = true; return {}; }
    return result.data || {};
  };
  const personalAddress = resolveStoredInvoicingAddress(await privateAddress('member', member.id), 'member');
  const choices = [{ kind: 'member', id: member.id, name: [member.first_name, member.last_name].filter(Boolean).join(' ') || member.email,
    first_name: member.first_name, last_name: member.last_name,
    email: member.email, invoicingAddress: personalAddress, bindings: bindings(member) }];
  const groupIds = new Set(member.organization_group_id ? [member.organization_group_id] : []);
  let organizationIds;
  try { organizationIds = await resolveBillingOrganizationIds(db, tenantId, member); }
  catch { incomplete = true; organizationIds = member.organization_id ? [member.organization_id] : []; }
  for (const organizationId of organizationIds) {
    const result = await db.from('organization').select('*').eq('tenant_id', tenantId).eq('id', organizationId).maybeSingle();
    if (result.error || !result.data) { incomplete = true; continue; }
    const org = result.data;
    if (org.organization_group_id) groupIds.add(org.organization_group_id);
    choices.push({ kind: 'organization', id: org.id, name: org.name, email: org.invoicing_email || null,
      invoicingAddress: resolveStoredInvoicingAddress({ ...org, ...await privateAddress('organization', org.id) }, 'organization'), bindings: bindings(org) });
  }
  for (const id of groupIds) {
    const result = await db.from('organization_group').select('*').eq('tenant_id', tenantId).eq('id', id).maybeSingle();
    if (result.error || !result.data) { incomplete = true; continue; }
    const group = result.data;
    // Groups do not necessarily support private-address ownership in older
    // installations. Never reinterpret an organisation's address as the group's.
    choices.push({ kind: 'organization_group', id, name: group.name,
      email: group.invoicing_email || null, invoicingAddress: resolveStoredInvoicingAddress(group, 'organization'), bindings: bindings(group) });
  }
  return { choices, personalAddress, incomplete };
}

function selectedAddress(selection, fallback) {
  if (!selection?.address) return fallback || null;
  if (typeof selection.address !== 'object' || Array.isArray(selection.address)
    || Object.keys(selection.address).some(key => !INVOICING_ADDRESS_KEYS.includes(key))) fail('Invalid invoice address', 400);
  const error = invoicingAddressError(selection.address);
  if (error) fail(error, 400);
  const address = Object.fromEntries(INVOICING_ADDRESS_KEYS.map(key => [key, String(selection.address[key] || '').trim()]));
  if (Object.values(address).every(value => !value)) return fallback || null;
  if (!address.invoicing_address_line1 || !address.invoicing_city || !address.invoicing_postal_code || !address.invoicing_country) {
    return fallback || null;
  }
  return resolveStoredInvoicingAddress(address, 'member');
}

export async function resolveUnifiedBookingCustomer({ db, tenantId, requestId, memberId, purchaser, selection }) {
  const booker = memberId ? { memberId } : {
    first_name: String(purchaser?.first_name || '').trim(), last_name: String(purchaser?.last_name || '').trim(),
    email: String(purchaser?.email || '').trim().toLowerCase(), organization: String(purchaser?.organization || '').trim(),
  };
  let contact;
  let selectedBindings;
  let originalBooker;
  if (memberId) {
    const { choices } = await unifiedBookingChoices(db, tenantId, memberId);
    const choice = choices.find(choice => choice.kind === (selection?.kind || 'member') && choice.id === (selection?.id || memberId));
    if (!choice) fail('The selected invoice customer is not linked to this member', 403);
    const self = choices[0];
    selectedBindings = choice.bindings;
    originalBooker = { id: memberId, first_name: self.first_name, last_name: self.last_name, name: self.name, email: self.email };
    contact = { name: choice.name, email: choice.email, isOrganization: choice.kind !== 'member',
      invoicingAddress: selectedAddress(selection, choice.invoicingAddress),
      provenance: { kind: choice.kind, id: choice.id } };
  } else {
    if (!booker.first_name || !booker.last_name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(booker.email)
      || booker.first_name.length > 250 || booker.last_name.length > 250 || booker.email.length > 320
      || booker.organization.length > 250) fail('Booker name and email are required', 400);
    if (selection?.kind && selection.kind !== 'guest') fail('Sign in to select a member invoice customer', 403);
    if (await publicTicketEmailExists(db, tenantId, booker.email)) fail('Members must sign in before booking', 403);
    originalBooker = booker;
    contact = { name: `${booker.first_name} ${booker.last_name}`, email: booker.email, isOrganization: false,
      organizationReference: booker.organization || null, invoicingAddress: selectedAddress(selection, null),
      provenance: { kind: 'guest_purchaser', requestId } };
  }
  return { contact, selectedBindings, originalBooker };
}

export function bindUnifiedBookingCustomer(contact, selectedBindings, provider) {
  const bound = structuredClone(contact);
  if (selectedBindings && provider) {
    const qbo = provider.name === 'quickbooks';
    const id = qbo ? selectedBindings.quickbooksId : selectedBindings.xeroId;
    const company = qbo ? selectedBindings.quickbooksCompany : selectedBindings.xeroCompany;
    const selectedCompany = qbo ? provider.realmId : provider.xeroTenantId;
    if (id) {
      if (!company || company !== selectedCompany) bound.providerBindingConflict = true;
      else bound.providerCustomerId = id;
    }
  }
  return bound;
}

export async function prepareUnifiedBookingContract({ db, tenantId, source, eventId, requestId, memberId, purchaser, selection, ticketIds = [] }) {
  if (!uuid.test(requestId || '') || !uuid.test(eventId || '') || !['booking', 'complex_event_booking'].includes(source)) {
    fail('A valid original checkout reference and event are required', 400);
  }
  const booker = memberId ? { memberId } : {
    first_name: String(purchaser?.first_name || '').trim(), last_name: String(purchaser?.last_name || '').trim(),
    email: String(purchaser?.email || '').trim().toLowerCase(), organization: String(purchaser?.organization || '').trim(),
  };
  const request = { booker, selection: selection || null, ticketIds: [...new Set(ticketIds.filter(Boolean).map(String))].sort() };
  const prior = await db.from('unified_booking_contract').select('*').eq('tenant_id', tenantId).eq('id', requestId).maybeSingle();
  if (prior.error) fail('Booking instructions are unavailable', 503);
  if (prior.data) {
    if (prior.data.source !== source || prior.data.event_id !== eventId || prior.data.member_id !== (memberId || null)
      || canonical(prior.data.snapshot.request) !== canonical(request)) fail('Checkout instructions changed. Resume the original checkout without paying again.');
    return prior.data;
  }
  if (!await unifiedBookingReady(db)) fail('The new booking flow is not enabled', 503);
  await assertStandaloneEventOffer({db,tenantId,eventKind:source==='booking'?'simple':'complex',eventId,ticketIds:request.ticketIds});
  const event = await db.from(source === 'booking' ? 'event' : 'complex_event').select('*')
    .eq('id', eventId).eq('tenant_id', tenantId).maybeSingle();
  if (event.error || !event.data) fail('Event not found', 404);
  const customer = await resolveUnifiedBookingCustomer({ db, tenantId, requestId, memberId, purchaser, selection });
  const originalBooker = customer.originalBooker;
  let accounting;
  try { accounting = await (await import('./eventInvoiceProducer.js')).loadEventInvoiceContext(db, tenantId); }
  catch { accounting = { reviewReason: 'Accounting configuration could not be frozen; review required', provider: null, settings: {} }; }
  const contact = bindUnifiedBookingCustomer(customer.contact, customer.selectedBindings, accounting.provider);
  const tickets = source === 'booking' ? event.data.pricing_config?.ticket_classes || []
    : await (await import('./ticketReleaseAccess.js')).loadComplexReleaseTickets(db, event.data);
  const policies = tickets.filter(ticket => request.ticketIds.includes(String(ticket.id))).map(ticket => ({
    ticketId: String(ticket.id), roleId: ticket.new_member_role_id || null,
    tax: { vat_rate_key: ticket.vat_rate_key || null, vat_rate_percentage: ticket.vat_rate_percentage ?? null,
      invoice_line_amount_type: ticket.invoice_line_amount_type || null },
    createMember: !memberId && ticket.audience_mode !== 'selected_members'
      && ['public_only', 'members_and_public'].includes(ticket.visibility_mode)
      && (ticket.create_member_records === true || ticket.auto_create_guest_accounts === true),
    enableLogin: ticket.auto_create_guest_accounts === true,
  }));
  const invoiceEvent = { title: event.data.title, internal_reference: event.data.internal_reference, xero_account_code: event.data.xero_account_code };
  const snapshot = { version: 2, request, booker: originalBooker, contact, accounting, policies, invoiceEvent };
  const result = await db.rpc('unified_booking_prepare', { p_id: requestId, p_tenant: tenantId, p_source: source,
    p_event: eventId, p_member: memberId || null, p_snapshot: snapshot });
  if(result.error?.code==='PT403') fail('This ticket requires its source registration in the same checkout.',403);
  if (result.error || !result.data?.id) fail('Booking instructions could not be frozen; retry the same checkout', 503);
  return result.data;
}

// Stripe request identity is persisted before the network write. An uncertain
// create is retried only with this exact request/key inside its safety window.
export async function createUnifiedBookingPayment({ db, stripe, contract, parameters }) {
  if (!contract.member_id && contract.snapshot && !contract.snapshot.contact.invoicingAddress && parameters.amount > 0) {
    fail('Invoice address line 1, city, postcode and country are required', 400);
  }
  const frozen = { ...parameters, metadata: { ...parameters.metadata, unified_booking_contract_id: contract.id, unified_booking_version: '2' } };
  const result = await db.rpc('unified_booking_payment_request', { p_id: contract.id, p_tenant: contract.tenant_id, p_parameters: frozen });
  if (result.error || !result.data) fail('Original payment instructions are unavailable', 503);
  const request = result.data;
  let payment;
  if (request.payment_intent_id) payment = await stripe.paymentIntents.retrieve(request.payment_intent_id);
  else {
    if (!Number.isFinite(Date.parse(request.payment_requested_at)) || Date.now() - Date.parse(request.payment_requested_at) > 23 * 3600000) {
      fail('The original payment requires review. Do not pay again.');
    }
    payment = await stripe.paymentIntents.create(request.payment_parameters, { idempotencyKey: `booking-v2:${contract.tenant_id}:${contract.id}` });
  }
  if (!/^pi_[A-Za-z0-9]+$/.test(payment?.id || '') || payment.amount !== request.payment_parameters.amount
    || payment.currency !== request.payment_parameters.currency || payment.metadata?.unified_booking_contract_id !== contract.id
    || payment.metadata?.tenant_id !== contract.tenant_id || payment.metadata?.event_id !== contract.event_id) fail('Original payment identity is inconsistent', 403);
  const bound = await db.rpc('unified_booking_payment_bind', { p_id: contract.id, p_tenant: contract.tenant_id, p_payment: payment.id });
  if (bound.error) fail('Payment binding is uncertain; retry the original checkout without paying again', 503);
  return payment;
}

export async function freezeUnifiedInvoice(input, contract) {
  const { enqueueCheckoutEventInvoice } = await import('./eventInvoiceProducer.js');
  let captured = null;
  let provider = 'xero';
  const reference = contract.snapshot.contact.organizationReference?.replace(/\s+/g, ' ').trim();
  const buildLines = reference && typeof input.buildLines === 'function'
    ? code => input.buildLines(code).map((line,index) => index === 0
      ? { ...line, Description: `Organisation reference: ${reference}\n\n${line.Description || ''}` } : line)
    : input.buildLines;
  const result = await enqueueCheckoutEventInvoice({
    ...input, buildLines, contact: contract.snapshot.contact, booker: contract.snapshot.booker,
    paymentMethod: input.paymentMethod === 'public_invoice_po' ? 'invoice' : input.paymentMethod,
    frozenContext: contract.snapshot.accounting.excluded && Number(input.amount) > 0
      ? { reviewReason: 'No accounting company was selected at checkout', settings: {}, provider: null }
      : contract.snapshot.accounting, bookingContractVersion: 2,
  }, {
    enqueue: async ({ snapshot }) => { captured = snapshot; return { status: 'pending' }; },
    captureAccountingEvent: async args => { provider = 'quickbooks'; captured = {
      ...args.p_snapshot, approvalProvider: { connectionId: args.p_connection, realmId: args.p_company },
    }; return { id: contract.id, state: 'pending' }; },
    logger: { error() {} },
  });
  return { version: 2, provider, snapshot: captured, status: result.status === 'not_applicable' ? 'not_applicable'
    : !captured || captured.reviewReasons?.length || captured.invoice?.reviewReason || contract.snapshot.accounting.reviewReason ? 'needs_review' : 'pending' };
}
