import { createHash } from 'node:crypto';
import { FunnelJourneyError } from '../../shared/eventFunnelJourney.mjs';
import { assertRequestedTicketsReleased, loadComplexReleaseTickets } from './ticketReleaseAccess.js';
import { funnelSimpleTickets } from '../../shared/eventFunnelCatalog.mjs';
import { isTicketVisibleToUser, resolveTicketPrice } from './complexEventPricing.js';
import { isPrivateTicket, isPrivateTicketEligible } from '../../shared/ticketAudience.js';
import { isTicketAccessibleToMember, isActiveMemberOfGroup } from './ticketAccess.js';
import { loadTicketOrganizationTypes } from './ticketOrganizationType.js';
import { assertEventCodeOfConduct } from './eventCodeOfConduct.js';
import { enforceAttendeeJobTitles } from './attendeeJobTitleRequirement.js';
import { loadEventInvoiceContext } from './eventInvoiceProducer.js';
import { loadEventPaymentPolicy } from './eventPaymentPolicy.js';
import { publicTicketEmailExists } from './publicTicketEmail.js';
import { getStripeCredentials } from './stripeCredentials.js';
import { isEventInPast, isPublicSimpleEventStatus } from '../../shared/eventTiming.js';
import { sanitizeOptionSelections, EMPTY_OPTION_SELECTIONS } from './eventOptionSelections.js';
import { publicTicketMemberPolicy } from '../../shared/publicTicketMemberPolicy.js';
import { registrationAssociationOptions } from './eventRegistrationAssociations.js';
import { memberSelfOnlyViolation } from '../../shared/eventRegisterOthers.js';

const deny = (message, status = 403, code = 'SELECTION_UNAVAILABLE') => { throw new FunnelJourneyError(message, code, status); };
const read = ({ data, error }, message) => {
  if (error || data == null) deny(message, 503, 'COMMERCIAL_UNAVAILABLE');
  return data;
};
const boundedText = (value, max = 250) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const email = value => boundedText(value, 320).toLowerCase();
const validEmail = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const monetary = value => {
  const number = Number(value);
  if (typeof value === 'boolean' || value === '' || value == null || !Number.isFinite(number) || number < 0
    || !Number.isSafeInteger(Math.round(number * 100))) deny('Ticket pricing is unavailable.', 503);
  return Math.round(number * 100);
};
// Saved JSONB snapshots may reorder object fields. Compare JSON values, not
// insertion order, while preserving array order and JSON's optional-field rules.
const key = value => JSON.stringify(value, (_name, child) =>
  child && typeof child === 'object' && !Array.isArray(child)
    ? Object.fromEntries(Object.keys(child).sort().map(name => [name, child[name]]))
    : child);
const providerIdentity = context => context?.excluded ? { name: 'none' } : context?.provider
  ? { name: context.provider.name || 'xero', connectionId: context.provider.connectionId,
    company: context.provider.realmId || context.provider.xeroTenantId, environment: context.provider.environment || 'production' }
  : { name: 'unconfigured' };

/** Only non-secret identity enters the reservation. No provider request is made. */
export async function loadFunnelCommercialAuthority(db, tenantId, dependencies = {}) {
  const [invoice, paymentPolicy, stripe] = await Promise.all([
    (dependencies.loadInvoiceContext || loadEventInvoiceContext)(db, tenantId),
    (dependencies.loadPaymentPolicy || loadEventPaymentPolicy)(db, tenantId),
    (dependencies.loadStripe || getStripeCredentials)(tenantId, 'events'),
  ]);
  return {
    accounting: providerIdentity(invoice),
    accountingSettings: invoice?.settings || {},
    stripe: stripe?.is_enabled !== false && stripe?.secret_key && stripe?.publishable_key
      ? { provider: 'stripe', feature: 'events', mode: stripe.mode,
        // Detect changed payment authority without retaining credentials.
        accountFingerprint: createHash('sha256').update(stripe.secret_key).digest('hex') } : null,
    funding: paymentPolicy,
  };
}

export function snapshotFunnelTicket(event, ticket, kind, authority, member) {
  const resolved = resolveTicketPrice([ticket], ticket.id);
  if (!resolved.found) deny('Ticket pricing is unavailable.', 503);
  if (!ticket.is_free) {
    monetary(ticket.price);
    if (ticket.early_bird_enabled && ticket.early_bird_price != null) monetary(ticket.early_bird_price);
  }
  const currency = String(resolved.currency).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) deny('The ticket currency is invalid.', 503);
  const groupSize = ticket.is_group_ticket === true ? Number(ticket.group_size) : 1;
  if (!Number.isSafeInteger(groupSize) || groupSize < 1 || groupSize > 10000) deny('The group-ticket size is invalid.', 503);
  const percentage = ticket.vat_rate_percentage == null || ticket.vat_rate_percentage === '' ? null : Number(ticket.vat_rate_percentage);
  if (percentage !== null && (!Number.isFinite(percentage) || percentage < 0)) deny('The ticket tax setting is invalid.', 503);
  const unitMinor = monetary(resolved.price);
  const paymentMethods = [
    ...(authority.stripe ? ['card'] : []),
    ...(member ? ['account'] : event.allow_public_invoice_po === true ? ['public_invoice_po'] : []),
  ];
  if (unitMinor > 0 && !paymentMethods.length) deny('No payment method is currently available for this event.', 409, 'INCOMPATIBLE_PAYMENT');
  const rules = kind === 'simple' ? {
    offerType: ticket.offer_type || null,
    bogoBuy: Number(ticket.bogo_buy_quantity || 0),
    bogoFree: Number(ticket.bogo_get_free_quantity || 0),
    bogoLogic: ticket.bogo_logic_type || 'buy_x_get_y_free',
    bulkThreshold: Number(ticket.bulk_discount_threshold || 0),
    bulkPercentage: Number(ticket.bulk_discount_percentage || 0),
  } : null;
  if (rules && (rules.offerType === 'bogo' && (!Number.isSafeInteger(rules.bogoBuy) || rules.bogoBuy < 1
    || !Number.isSafeInteger(rules.bogoFree) || rules.bogoFree < 1
    || !['enter_total_pay_less', 'buy_x_get_y_free'].includes(rules.bogoLogic))
    || rules.offerType === 'bulk_discount' && (!Number.isSafeInteger(rules.bulkThreshold) || rules.bulkThreshold < 1
      || !Number.isFinite(rules.bulkPercentage) || rules.bulkPercentage < 0 || rules.bulkPercentage > 100))) {
    deny('The ticket offer settings are invalid.', 503);
  }
  return {
    version: 1, unitMinor, unitAmount: resolved.price, currency, eventId: event.id, eventKind: kind,
    eventTitle: boundedText(event.title, 1000), eventReference: boundedText(event.internal_reference),
    ticketId: String(ticket.id), ticketName: boundedText(ticket.name), groupSize,
    tax: { percentage, key: ticket.vat_rate_key || null, lineAmountType: 'Inclusive' },
    accountCode: event.xero_account_code || authority.accountingSettings.xero_sales_account_code || null,
    rules, paymentMethods, commercial: authority, purchaserKind: member ? 'member' : 'guest',
    ticketMemberPolicy: publicTicketMemberPolicy(ticket),
  };
}

export function funnelLineTotal(snapshot, quantity) {
  if (snapshot?.version !== 1 || !Number.isSafeInteger(snapshot.unitMinor) || snapshot.unitMinor < 0
    || !Number.isSafeInteger(quantity) || quantity < 1) deny('Saved ticket pricing is unavailable.', 503);
  let payable = quantity;
  const rules = snapshot.rules;
  if (rules?.offerType === 'bogo') {
    const bundle = rules.bogoBuy + rules.bogoFree;
    const remainder = quantity % bundle;
    payable = Math.floor(quantity / bundle) * rules.bogoBuy
      + (rules.bogoLogic === 'enter_total_pay_less' ? remainder : Math.min(remainder, rules.bogoBuy));
  }
  if (snapshot.unitAmount != null && (typeof snapshot.unitAmount !== 'number' || !Number.isFinite(snapshot.unitAmount)
    || snapshot.unitAmount < 0 || Math.round(snapshot.unitAmount * 100) !== snapshot.unitMinor)) deny('Saved ticket pricing is unavailable.', 503);
  let total = (snapshot.unitAmount == null ? snapshot.unitMinor / 100 : snapshot.unitAmount) * payable;
  if (rules?.offerType === 'bulk_discount' && quantity >= rules.bulkThreshold) total *= (100 - rules.bulkPercentage) / 100;
  total = Math.round(total * 100);
  if (!Number.isSafeInteger(total) || total < 0) deny('The ticket total is invalid.', 503);
  return total;
}

export function assertFunnelCommercialCompatibility(lines) {
  let currency = null, commercial = null, methods = null, totalMinor = 0;
  for (const line of lines) {
    const snapshot = line.priceSnapshot || line.price_snapshot;
    const total = funnelLineTotal(snapshot, line.quantity);
    if (currency && currency !== snapshot.currency) deny('These events use different currencies. Keep or remove the optional event.', 409, 'INCOMPATIBLE_CURRENCY');
    currency ||= snapshot.currency;
    totalMinor += total;
    if (!Number.isSafeInteger(totalMinor)) deny('Checkout total is too large.', 400);
    if (!total) continue;
    const identity = key({ accounting: snapshot.commercial?.accounting, stripe: snapshot.commercial?.stripe });
    if (commercial && identity !== commercial) deny('These events use different payment or accounting accounts.', 409, 'INCOMPATIBLE_COMPANY');
    commercial ||= identity;
    methods = methods === null ? [...snapshot.paymentMethods] : methods.filter(method => snapshot.paymentMethods.includes(method));
    if (!methods.length) deny('These tickets do not share an available payment method.', 409, 'INCOMPATIBLE_PAYMENT');
  }
  return { currency, totalMinor, paymentMethods: totalMinor === 0 ? ['free'] : methods || [] };
}

function normalizeAttendee(value, options, collectOptions) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) deny('Complete every attendee’s details.', 400);
  const result = {
    first_name: boundedText(value.first_name ?? value.firstName),
    last_name: boundedText(value.last_name ?? value.lastName), email: email(value.email),
    organization: boundedText(value.organization), phone: boundedText(value.phone, 100),
    job_title: boundedText(value.job_title), ...(collectOptions ? sanitizeOptionSelections(value, options) : EMPTY_OPTION_SELECTIONS),
  };
  if (!result.first_name || !result.last_name || !validEmail(result.email)) deny('Complete each attendee’s name and email.', 400);
  if (value.registration_association != null) {
    if (!['organization', 'group'].includes(value.registration_association.kind)) deny('Invalid registration association.', 400);
    result.registration_association = structuredClone(value.registration_association);
  }
  return result;
}

export function createFunnelSelectionResolver({ db, loadAuthority = loadFunnelCommercialAuthority }) {
  async function resolveSelection({ owner, node, tickets, answers, previousHolds, snapshot, selections, rereserve }) {
    const event = read(await db.from(node.event.kind === 'simple' ? 'event' : 'complex_event').select('*')
      .eq('tenant_id', owner.tenantId).eq('id', node.event.id).maybeSingle(), 'This event is no longer available.');
    if (event.tenant_id !== owner.tenantId
      || !(node.event.kind === 'simple' ? isPublicSimpleEventStatus(event) : ['published', 'tbc'].includes(event.status))
      || ['draft', 'closed', 'cancelled'].includes(event.event_state) || event.status === 'closed'
      || isEventInPast(event) || event.registration_closes_at && Date.parse(event.registration_closes_at) <= Date.now()) {
      deny('Registration for this event is unavailable.', 409);
    }
    if (event.waiting_list_enabled === true || node.event.kind === 'simple' && event.program_tag) {
      deny('Waiting lists and programme entitlements use their existing registration process.', 409);
    }
    if (event.registration_closes_at && !Number.isFinite(Date.parse(event.registration_closes_at))) {
      deny('The event registration deadline is invalid.', 503);
    }
    const member = owner.memberId ? read(await db.from('member').select('*').eq('tenant_id', owner.tenantId)
      .eq('id', owner.memberId).maybeSingle(), 'Purchaser membership could not be verified.') : null;
    if (member && (member.login_enabled === false || member.membership_paused === true
      || member.email?.endsWith('@deleted.local'))) deny('This member cannot currently register.', 403);
    const catalog = node.event.kind === 'simple' ? funnelSimpleTickets(event) : await loadComplexReleaseTickets(db, event);
    const requested = assertRequestedTicketsReleased({ event, tickets: catalog, ticketIds: tickets.map(t => t.id), eventKind: node.event.kind });
    const groups = member ? read(await db.from('member_group_assignment').select('group_id').eq('tenant_id', owner.tenantId).eq('member_id', member.id),
      'Ticket eligibility could not be verified.').map(row => row.group_id) : [];
    const viewer = member ? { memberId: member.id, tenantId: owner.tenantId, roleId: member.role_id,
      organizationTypes: await loadTicketOrganizationTypes(db, owner.tenantId, member.id) } : null;
    for (const ticket of requested) {
      if (ticket.audience_mode && !['legacy', 'selected_members'].includes(ticket.audience_mode)) deny('Ticket eligibility is unavailable.', 503);
      if (isPrivateTicket(ticket)) {
        if (!isPrivateTicketEligible(ticket, viewer, owner.tenantId)) deny('You do not have access to this ticket.');
      } else if (!isTicketVisibleToUser(ticket, !!member)) deny('You do not have access to this ticket.');
      if (!isTicketAccessibleToMember({ ticketClass: ticket, isAuthenticated: !!member, memberRoleId: member?.role_id, memberGroupIds: groups,
        memberId: member?.id, tenantId: owner.tenantId, ticketTenantId: owner.tenantId, organizationTypeViewer: viewer })) {
        deny('You do not meet this ticket’s eligibility requirements.');
      }
    }
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) deny('Complete the attendee information.', 400);
    await assertEventCodeOfConduct(db, owner.tenantId, answers);
    const settings = read(await db.from('system_settings').select('setting_key,setting_value').eq('tenant_id', owner.tenantId)
      .in('setting_key', ['event_booking_terms', 'collect_attendee_options']), 'Event registration settings could not be verified.');
    const terms = settings.find(s => s.setting_key === 'event_booking_terms')?.setting_value || '';
    if (terms && terms !== '<p><br></p>' && (answers.terms_accepted !== true || answers.terms_content !== terms)) {
      deny('Review and accept the current booking terms.', 400);
    }
    const collectOptions = settings.find(s => s.setting_key === 'collect_attendee_options')?.setting_value !== 'false';
    const bookerInput = member || answers.purchaser || snapshot.drafts[snapshot.graph.entry]?.purchaser;
    const purchaser = {
      first_name: boundedText(bookerInput?.first_name), last_name: boundedText(bookerInput?.last_name),
      email: email(bookerInput?.email), organization: boundedText(bookerInput?.organization),
    };
    if (!purchaser.first_name || !purchaser.last_name || !validEmail(purchaser.email)) deny('Enter the purchaser’s name and email.', 400);
    if (!member && await publicTicketEmailExists(db, owner.tenantId, purchaser.email)) deny('Please sign in before booking with a member email.');
    const sourcePurchaser = snapshot.holds.find(hold => hold.node_id === snapshot.graph.entry)?.price_snapshot?.purchaser;
    if (!member && sourcePurchaser && key(purchaser) !== key({
      first_name: boundedText(sourcePurchaser.first_name), last_name: boundedText(sourcePurchaser.last_name),
      email: email(sourcePurchaser.email), organization: boundedText(sourcePurchaser.organization),
    })) deny('The original purchaser cannot be changed during this reservation.', 409);
    const attendees = [], attendeesByTicket = Object.create(null);
    for (const selection of tickets) {
      const rows = answers.attendeesByTicket?.[selection.id] || (tickets.length === 1 ? answers.attendees : null);
      if (!Array.isArray(rows) || rows.length !== selection.quantity) deny('Provide attendee information for every selected ticket.', 400);
      attendeesByTicket[selection.id] = rows.map(row => normalizeAttendee(row, event, collectOptions));
      attendees.push(...attendeesByTicket[selection.id]);
    }
    await enforceAttendeeJobTitles(db, owner.tenantId, attendees);
    const associations = new Map();
    for (const attendee of attendees) if (attendee.registration_association) {
      const selection = attendee.registration_association;
      const associationKey = `${selection.kind}:${selection.id}`;
      if (!associations.has(associationKey)) {
        const options = await registrationAssociationOptions(db, {
          tenantId: owner.tenantId, eventId: event.id, eventKind: node.event.kind, kind: selection.kind, id: selection.id,
        });
        const approved = options?.options?.find(item => item.id === selection.id && item.kind === selection.kind);
        if (!approved) deny('The selected organisation or group is no longer available.', 409);
        associations.set(associationKey, { kind: approved.kind, id: approved.id, name: approved.name });
      }
      attendee.registration_association = associations.get(associationKey);
    }
    if (event.member_group_id) {
      if (event.group_event_public !== true && (!member || !await isActiveMemberOfGroup(db, member.id, event.member_group_id))) {
        deny('Only active members of this event’s group can register.');
      }
      if (attendees.length !== 1 || attendees[0].email !== purchaser.email) deny('Group events only allow self-registration.');
    }
    if (member) {
      const selfOnly = memberSelfOnlyViolation(event, attendees, member.email);
      if (selfOnly) deny(selfOnly);
    }
    const authority = await loadAuthority(db, owner.tenantId);
    const result = tickets.map(selection => {
      const previous = previousHolds.find(hold => hold.ticket_id === selection.id);
      return { ticketId: selection.id, priceSnapshot: previous && !rereserve ? previous.price_snapshot
        : { ...snapshotFunnelTicket(event, requested.find(ticket => String(ticket.id) === selection.id), node.event.kind, authority, member),
          purchaser: sourcePurchaser || purchaser } };
    });
    const keep = new Set(selections.map(selection => selection.nodeId));
    const existing = rereserve ? [] : snapshot.holds.filter(hold => keep.has(hold.node_id) && hold.node_id !== node.id);
    assertFunnelCommercialCompatibility([...existing, ...result.map(line => ({
      ...line, quantity: tickets.find(ticket => ticket.id === line.ticketId).quantity,
    }))]);
    const pricingConfig = typeof event.pricing_config === 'string' && event.pricing_config
      ? JSON.parse(event.pricing_config) : event.pricing_config;
    return { lines: result, answers: { ...answers, purchaser: sourcePurchaser || purchaser, attendeesByTicket,
      third_party_consent: pricingConfig?.collectThirdPartyConsent === true && typeof answers.third_party_consent === 'boolean'
        ? answers.third_party_consent : null,
      ...(tickets.length === 1 ? { attendees } : {}) } };
  }
  return async input => {
    try { return await resolveSelection(input); }
    catch (error) {
      if (error instanceof FunnelJourneyError) throw error;
      if ([400, 403, 409].includes(error?.statusCode)) {
        throw new FunnelJourneyError(error.message, error.code || 'INVALID_ATTENDEE_DETAILS', error.statusCode);
      }
      throw new FunnelJourneyError('Event eligibility or pricing could not be checked. Your existing reservation is unchanged.',
        'COMMERCIAL_UNAVAILABLE', 503);
    }
  };
}
