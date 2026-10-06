import { isStrictIsoDate } from './teamRoleAssignment.js';
import { registrationMemberLinks } from './eventRegistrationMemberLinks.js';

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
function reject(message, status = 400) { throw Object.assign(new Error(message), { status }); }
export function registrationMemberInput(body) {
  if (!uuid(body?.bookingId) || ![true, false, 'true', 'false'].includes(body.isComplex)) reject('Select a valid registration.');
  return { bookingId: body.bookingId, isComplex: body.isComplex === true || body.isComplex === 'true' };
}
export function reviewedMemberInput(body) {
  const result = registrationMemberInput(body);
  for (const key of ['first_name', 'last_name', 'email', 'supplied_organization_name']) {
    if (body[key] != null && typeof body[key] !== 'string') reject('Invalid member details.');
    result[key] = (body[key] || '').trim();
    if (result[key].length > (key === 'email' ? 320 : 250)) reject('Member details are too long.');
  }
  result.email = result.email.toLowerCase();
  if (!result.first_name || !result.last_name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result.email)) reject('First name, last name and a valid email are required.');
  if (!uuid(body.role_id) || (body.organization_id && !uuid(body.organization_id))) reject('Select a valid role and organisation.');
  result.role_id = body.role_id;
  result.organization_id = body.organization_id || null;
  result.role_effective_from = body.role_effective_from || null;
  if (result.role_effective_from && !isStrictIsoDate(result.role_effective_from)) reject('Enter a valid role effective date.');
  return result;
}

export function makeEventRegistrationMemberHandler({ db, getContext, adminAccess, featureAccess }) {
  return async (req, res) => {
    if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
    try {
      const ctx = await getContext(req);
      if (!ctx?.isAuthenticated || !ctx.tenantId) return res.status(401).json({ error: 'Sign in to continue.' });
      if (ctx.tenantMismatch) return res.status(409).json({ error: 'Tenant context changed. Reload this page.' });
      if (!await adminAccess(ctx) || (ctx.roleId && (
        !await featureAccess(ctx.roleId, 'events.event-report', ctx.memberExcludedFeatures)
        || !await featureAccess(ctx.roleId, 'admin.role-management', ctx.memberExcludedFeatures)
      ))) return res.status(403).json({ error: 'Report and role-management administrator access is required.' });
      const input = req.method === 'POST' ? reviewedMemberInput(req.body) : registrationMemberInput(req.query);
      const table = input.isComplex ? 'complex_event_booking' : 'booking';
      if (req.method === 'POST') {
        const { data, error } = await db.rpc('create_member_from_event_registration', {
          p_tenant_id: ctx.tenantId, p_booking_id: input.bookingId, p_complex: input.isComplex,
          p_first_name: input.first_name, p_last_name: input.last_name, p_email: input.email,
          p_supplied_organization_name: input.supplied_organization_name,
          p_organization_id: input.organization_id, p_role_id: input.role_id,
          p_role_effective_from: input.role_effective_from,
        });
        if (error) {
          if (error.code === '23505') reject('A member with this email already exists. No new member was created.', 409);
          if (['P0001', '22023', '23514'].includes(error.code)) reject(error.message, 409);
          reject('Unable to create the member. No partial changes were saved.', 503);
        }
        return res.json(data);
      }
      const { data: booking, error } = await db.from(table).select('*')
        .eq('id', input.bookingId).eq('tenant_id', ctx.tenantId).maybeSingle();
      if (error) reject('Unable to load the registration.', 503);
      if (!booking) reject('Registration not found.', 404);
      if (!booking.member_id && !input.isComplex && booking.is_guest_booking !== true && booking.organization_id) reject('This is not a guest registration.', 409);
      if (!booking.member_id && input.isComplex && booking.organization_id) reject('This is not a guest registration.', 409);
      const { data: event, error: eventError } = await db.from(input.isComplex ? 'complex_event' : 'event')
        .select('id,title').eq('id', booking.event_id).eq('tenant_id', ctx.tenantId).maybeSingle();
      if (eventError) reject('Unable to load the event.', 503);
      if (!event) reject('Event not found.', 404);
      const existingLinks = booking.member_id ? new Map() : await registrationMemberLinks(db, ctx.tenantId, [
        { id: booking.id, isComplex: input.isComplex },
      ]);
      const linkedMemberId = booking.member_id || existingLinks.get(`${input.isComplex ? 'complex' : 'simple'}:${booking.id}`) || null;
      const rolesQuery = db.from('role').select('id,name,requires_effective_from_date,max_members').eq('tenant_id', ctx.tenantId).order('name').order('id');
      // Bound search results; never return another tenant's organisations.
      let orgQuery = db.from('organization').select('id,name').eq('tenant_id', ctx.tenantId).order('name').order('id').limit(50);
      const search = String(req.query.organisationSearch || '').trim().slice(0, 150);
      if (search) orgQuery = orgQuery.filter('name', 'imatch', search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      const roles = [];
      for (let offset = 0; ;) {
        const page = await rolesQuery.range(offset, offset + 199);
        if (page.error) reject('Unable to load tenant roles.', 503);
        if (!page.data?.length) break;
        roles.push(...page.data); offset += page.data.length;
      }
      const orgs = await orgQuery;
      if (orgs.error) reject('Unable to search tenant organisations.', 503);
      return res.json({
        registration: {
          bookingId: booking.id, isComplex: input.isComplex, eventTitle: event.title,
          ticketName: booking.ticket_class_name, first_name: booking.attendee_first_name || '',
          last_name: booking.attendee_last_name || '', email: booking.attendee_email || '',
          supplied_organization_name: booking.guest_organisation_name || booking.attendee_organization || '',
          member_id: linkedMemberId, phone: booking.attendee_phone || '',
          job_title: booking.attendee_job_title || '', booking_reference: booking.booking_reference || '',
        },
        roles, organisations: orgs.data || [],
      });
    } catch (error) {
      return res.status(error.status || 500).json({ error: error.status ? error.message : 'Unable to process the registration.' });
    }
  };
}
