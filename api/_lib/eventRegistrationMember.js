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
   if (!uuid(body.role_id) || (body.organization_id != null && !uuid(body.organization_id))
     || (body.organization_group_id != null && !uuid(body.organization_group_id))) reject('Select a valid role and organisation or group.');
   if (body.organization_id && body.organization_group_id) reject('Select either an organisation or a group, not both.');
  result.role_id = body.role_id;
  result.organization_id = body.organization_id || null;
   result.organization_group_id = body.organization_group_id || null;
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
      const identity = (req.method === 'POST' ? req.body : req.query)?.identity || 'attendee';
      if (!['attendee', 'purchaser'].includes(identity)) reject('Invalid registration contact.');
      if (req.method === 'POST') {
        const { data, error } = await db.rpc(identity === 'purchaser' ? 'create_public_invoice_booker' : 'create_member_from_event_registration', {
          p_tenant_id: ctx.tenantId, p_booking_id: input.bookingId, p_complex: input.isComplex,
          p_first_name: input.first_name, p_last_name: input.last_name, p_email: input.email,
          p_supplied_organization_name: input.supplied_organization_name,
          p_organization_id: input.organization_id, p_role_id: input.role_id,
           p_organization_group_id: input.organization_group_id,
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
      const purchaser = identity === 'purchaser' ? booking.purchaser_context?.details : null;
      if (identity === 'purchaser' && (booking.purchaser_context?.classification !== 'public_non_member'
        || !purchaser?.email || !['public_invoice_po','invoice'].includes(booking.payment_method))) reject('Original Invoice / PO booker details are unavailable.', 409);
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
      let bookerMemberId = null;
      if (purchaser) {
        const result = await db.from('member').select('id,email').eq('tenant_id', ctx.tenantId)
          .ilike('email', purchaser.email.trim().replace(/[%_\\]/g, '\\$&')).limit(2);
        if (result.error || result.data?.length > 1) reject('The original booker account needs review.', 409);
        bookerMemberId = result.data?.[0]?.id || null;
      }
      const rolesQuery = db.from('role').select('id,name,requires_effective_from_date,max_members').eq('tenant_id', ctx.tenantId).order('name').order('id');
      // Bound search results; never return another tenant's organisations.
      let orgQuery = db.from('organization').select('id,name').eq('tenant_id', ctx.tenantId).order('name').order('id').limit(50);
       let groupQuery = db.from('organization_group').select('id,name').eq('tenant_id', ctx.tenantId).order('name').order('id').limit(50);
      const search = String(req.query.organisationSearch || '').trim().slice(0, 150);
      if (search) orgQuery = orgQuery.filter('name', 'imatch', search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
       if (search) groupQuery = groupQuery.filter('name', 'imatch', search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      const roles = [];
      for (let offset = 0; ;) {
        const page = await rolesQuery.range(offset, offset + 199);
        if (page.error) reject('Unable to load tenant roles.', 503);
        if (!page.data?.length) break;
        roles.push(...page.data); offset += page.data.length;
      }
       const [orgs, groups] = await Promise.all([orgQuery, groupQuery]);
       if (orgs.error || groups.error) reject('Unable to search organisations and groups.', 503);
       const associations = [
         ...(orgs.data || []).map(row => ({ ...row, type: 'organization' })),
         ...(groups.data || []).map(row => ({ ...row, type: 'organization_group' })),
       ].sort((a, b) => a.name.localeCompare(b.name, 'en') || a.type.localeCompare(b.type) || a.id.localeCompare(b.id)).slice(0, 50);
      return res.json({
        registration: {
          bookingId: booking.id, isComplex: input.isComplex, eventTitle: event.title,
          ticketName: booking.ticket_class_name, first_name: purchaser ? purchaser.first_name || '' : booking.attendee_first_name || '',
          last_name: purchaser ? purchaser.last_name || '' : booking.attendee_last_name || '', email: purchaser ? purchaser.email : booking.attendee_email || '',
          supplied_organization_name: purchaser ? purchaser.organization || purchaser.organization_name || '' : booking.guest_organisation_name || booking.attendee_organization || '',
          member_id: purchaser ? bookerMemberId : linkedMemberId, phone: purchaser ? purchaser.phone || '' : booking.attendee_phone || '',
          job_title: booking.attendee_job_title || '', booking_reference: booking.booking_reference || '',
        },
         roles, organisations: orgs.data || [], associations,
      });
    } catch (error) {
      return res.status(error.status || 500).json({ error: error.status ? error.message : 'Unable to process the registration.' });
    }
  };
}
