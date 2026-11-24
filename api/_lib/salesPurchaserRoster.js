import { SalesHttpError } from './salesAccess.js';
import { fulfilmentResult } from './salesCustomerFulfilment.js';
import { hashAllocationInviteToken, deriveAllocationInviteToken } from './allocationInvitation.js';
import { assertEventCodeOfConduct } from './eventCodeOfConduct.js';
import { sanitizeOptionSelections, EMPTY_OPTION_SELECTIONS } from './eventOptionSelections.js';
import { requireAttendeeJobTitle } from '../../shared/attendeeJobTitleRequirement.js';
import { ticketRegistrationDeadline } from '../../shared/ticketRelease.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const settingsKeys = ['event_booking_terms', 'event_code_of_conduct', 'collect_attendee_options', 'require_attendee_job_title'];
const text = (value, max = 200) => {
  if (value == null) return '';
  if (typeof value !== 'string' || value.length > max) throw new SalesHttpError(400, 'An attendee field is too long or invalid');
  return value.trim();
};

export async function purchaserAllocationAuthority(db, row, allocationId) {
  const a = await fulfilmentResult(db.from('sales_commercial_allocation').select('*')
    .eq('tenant_id', row.tenant_id).eq('sale_id', row.sale_id).eq('id', allocationId).maybeSingle());
  if (!a) throw new SalesHttpError(404, 'Allocation not found');
  const event = await fulfilmentResult(db.from(a.event_reference_kind === 'complex' ? 'complex_event' : 'event').select('*')
    .eq('tenant_id', row.tenant_id).eq('id', a.event_id).maybeSingle());
  if (!event) throw new SalesHttpError(409, 'The purchased event is unavailable');
  const ticket = a.event_reference_kind === 'complex'
    ? await fulfilmentResult(db.from('complex_event_ticket_class').select('*').eq('tenant_id', row.tenant_id)
      .eq('complex_event_id', a.event_id).eq('id', a.ticket_type_id).maybeSingle())
    : event.pricing_config?.ticket_classes?.find(t => String(t.id) === a.ticket_type_id);
  if (!ticket) throw new SalesHttpError(409, 'The purchased ticket type is unavailable');
  return { allocation: a, event, ticket };
}

export async function purchaserRegistrationSettings(db, tenantId) {
  const settings = await fulfilmentResult(db.from('system_settings').select('setting_key,setting_value')
    .eq('tenant_id', tenantId).in('setting_key', settingsKeys));
  const value = key => settings.find(s => s.setting_key === key)?.setting_value;
  let conduct = value('event_code_of_conduct');
  if (typeof conduct === 'string') {
    try { conduct = JSON.parse(conduct); }
    catch { throw new SalesHttpError(503, 'The event Code of Conduct is unavailable'); }
  }
  return { terms: value('event_booking_terms') || '', codeOfConduct: conduct || null,
    requireJobTitle: requireAttendeeJobTitle(settings),
    collectOptions: ![false, 'false'].includes(value('collect_attendee_options')) };
}

export async function savePurchaserSlot(db, row, token, input) {
  if (!uuid.test(input.allocationId || '') || !uuid.test(input.slotId || '') || !uuid.test(input.commandId || '')
    || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0
    || typeof input.complete !== 'boolean' || !input.details || typeof input.details !== 'object' || Array.isArray(input.details)) {
    throw new SalesHttpError(400, 'Valid slot, version and attendee details are required');
  }
  const { event, ticket } = await purchaserAllocationAuthority(db, row, input.allocationId);
  const deadline = ticketRegistrationDeadline(event, ticket);
  if (deadline.closed) throw new SalesHttpError(409, deadline.reason);
  const settings = await purchaserRegistrationSettings(db, row.tenant_id);
  const details = { first_name: text(input.details.first_name), last_name: text(input.details.last_name),
    email: text(input.details.email, 254).toLowerCase(), phone: text(input.details.phone, 100),
    organization: text(input.details.organization), job_title: text(input.details.job_title),
    ...(settings.collectOptions ? sanitizeOptionSelections(input.details, event) : EMPTY_OPTION_SELECTIONS) };
  if (input.complete) {
    if (event.member_group_id) {
      throw new SalesHttpError(409, 'This group event requires attendees to register themselves. Ask the organiser for an attendee invitation.');
    }
    if (!details.first_name || !details.last_name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(details.email)) {
      throw new SalesHttpError(400, 'Enter the attendee’s first name, last name and email');
    }
    if (settings.requireJobTitle && !details.job_title) throw new SalesHttpError(400, 'Enter the attendee’s job title');
    if (settings.terms && settings.terms !== '<p><br></p>'
      && (input.termsAccepted !== true || input.termsContent !== settings.terms)) {
      throw new SalesHttpError(409, 'Review and accept the current booking terms');
    }
    try {
      await assertEventCodeOfConduct(db, row.tenant_id, {
        code_of_conduct_accepted: input.codeOfConductAccepted, code_of_conduct_content: input.codeOfConductContent,
      });
    } catch (error) { throw new SalesHttpError(error.statusCode || 400, error.message); }
  }
  const inviteToken = deriveAllocationInviteToken(row.tenant_id, input.allocationId,
    { actorType: 'tenant_user', actorId: row.id }, `roster:${input.slotId}`);
  return fulfilmentResult(db.rpc('save_sales_purchaser_slot', {
    p_tenant: row.tenant_id, p_hash: hashAllocationInviteToken(token), p_allocation: input.allocationId,
    p_slot: input.slotId, p_expected: input.expectedVersion, p_command: input.commandId,
    p_details: details, p_complete: input.complete, p_invite_hash: hashAllocationInviteToken(inviteToken),
    p_terms: input.complete ? { terms: settings.terms, codeOfConduct: settings.codeOfConduct } : null,
  }));
}
