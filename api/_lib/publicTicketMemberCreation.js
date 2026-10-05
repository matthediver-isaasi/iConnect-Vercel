// These helpers accept tickets loaded by the server, never submitted ticket
// objects. Kept independent of payment and session state so both event systems
// can use the same pre-payment contract.
export class PublicTicketMemberError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
    this.statusCode = status;
  }
}

const fail = (code, message, status) => {
  throw new PublicTicketMemberError(code, message, status);
};

export const normalizePublicTicketEmail = value => (
  typeof value === 'string' ? value.trim().toLowerCase() : ''
);

export function publicTicketIdentity(value, label = 'Each person') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('IDENTITY_REQUIRED', `${label} requires explicit contact details.`);
  }
  const identity = {};
  for (const field of ['first_name', 'last_name', 'organization', 'email']) {
    const raw = value[field];
    if (typeof raw !== 'string' || !raw.trim() || raw.length > 320) {
      fail('IDENTITY_REQUIRED', `${label} requires first name, last name, organisation and email (at most 320 characters each).`);
    }
    identity[field] = raw.trim();
  }
  identity.email = normalizePublicTicketEmail(identity.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identity.email)) {
    fail('INVALID_EMAIL', `${label} requires a valid email address.`);
  }
  return identity;
}

export function assertPublicTicketRole(role, tenantId) {
  if (!tenantId || !role || role.tenant_id !== tenantId
      || role.is_admin === true || role.is_tenant_admin === true
      || role.requires_effective_from_date === true
      || role.requires_organization === true || role.max_members != null) {
    fail('ROLE_NOT_PROVISIONABLE', 'Select a role from this tenant without administrator, organisation, capacity or effective-date requirements.');
  }
  return role.id;
}

export async function loadPublicTicketMemberRoles(db, tenantId, tickets) {
  const ids = [...new Set(tickets.filter(ticket => ticket?.create_member_records === true)
    .map(ticket => ticket.new_member_role_id))];
  if (!ids.length) return [];
  if (ids.some(id => typeof id !== 'string' || !id) || ids.length > 100) {
    fail('ROLE_NOT_PROVISIONABLE', 'Select a role for each enabled ticket.');
  }
  const { data, error } = await db.from('role')
    .select('id,tenant_id,is_admin,is_tenant_admin,requires_effective_from_date,max_members')
    .eq('tenant_id', tenantId).in('id', ids);
  if (error || !Array.isArray(data)) {
    fail('ROLE_VALIDATION_UNAVAILABLE', 'Unable to validate ticket member roles.', 503);
  }
  for (const id of ids) assertPublicTicketRole(data.find(role => role.id === id), tenantId);
  return data;
}

export async function validatePublicTicketMemberPolicyWrite({
  db, tenantId, tickets, authorizedToAssignRoles,
}) {
  if (!Array.isArray(tickets)) fail('INVALID_TICKET_POLICY', 'Ticket classes must be a list.');
  const enabled = tickets.filter(ticket => ticket?.create_member_records === true);
  if (!enabled.length) return;
  if (!authorizedToAssignRoles) {
    fail('ROLE_ASSIGNMENT_FORBIDDEN', 'Administrator access is required to configure ticket member creation.', 403);
  }
  if (enabled.some(ticket => ticket.visibility_mode !== 'public_only')) {
    fail('INVALID_TICKET_POLICY', 'Member creation is only available on Public only tickets.');
  }
  await loadPublicTicketMemberRoles(db, tenantId, enabled);
}

export function buildPublicTicketMemberSnapshot({ tenantId, purchaser, items, roles }) {
  if (!Array.isArray(items) || items.length > 100) {
    fail('INVALID_ITEMS', 'A bounded list of ticket items is required.');
  }
  const enabled = items.filter(item => item.ticket?.create_member_records === true);
  if (!enabled.length) return null;
  const people = new Map();
  const ticketPolicies = [];
  const add = (identity, roleId, link) => {
    const existing = people.get(identity.email);
    if (existing && existing.role_id !== roleId) {
      fail('ROLE_CONFLICT', 'The same person would receive different roles. Choose tickets with the same new-member role.');
    }
    if (existing && ['first_name', 'last_name', 'organization']
      .some(field => existing.identity[field] !== identity[field])) {
      fail('IDENTITY_CONFLICT', 'The same email has conflicting contact details. Correct the purchaser and attendee details.');
    }
    const person = existing || { identity, role_id: roleId, links: [] };
    if (!person.links.some(prior => JSON.stringify(prior) === JSON.stringify(link))) {
      person.links.push(link);
    }
    people.set(identity.email, person);
  };
  const buyer = publicTicketIdentity(purchaser, 'The purchaser');
  for (const item of enabled) {
    const ticket = item.ticket;
    if (ticket.visibility_mode !== 'public_only') {
      fail('INVALID_TICKET_POLICY', 'Member creation is only available on Public only tickets.');
    }
    const role = roles.find(candidate => candidate.id === ticket.new_member_role_id);
    const roleId = assertPublicTicketRole(role, tenantId);
    if (!Array.isArray(item.attendees) || !item.attendees.length || item.attendees.length > 100) {
      fail('IDENTITY_REQUIRED', 'Provide the attendees receiving each ticket before payment.');
    }
    ticketPolicies.push({ ticket_id: String(ticket.id), role_id: roleId, attendee_count: item.attendees.length });
    add(buyer, roleId, { kind: 'purchaser' });
    item.attendees.forEach((attendee, index) => {
      add(publicTicketIdentity(attendee, 'Each attendee'), roleId, {
        kind: 'attendee', ticket_id: String(ticket.id), item_index: items.indexOf(item), index,
      });
    });
  }
  if (people.size > 101) fail('TOO_MANY_PEOPLE', 'A purchase can create at most 101 contact records.');
  return {
    version: 1, tenant_id: tenantId, purchaser: buyer, ticket_policies: ticketPolicies,
    booking_items: items.map(item => ({
      ticket_id: String(item.ticket.id),
      attendees: (item.attendees || []).map(person => ({
        email: normalizePublicTicketEmail(person.email),
        first_name: typeof person.first_name === 'string' ? person.first_name.trim() : '',
        last_name: typeof person.last_name === 'string' ? person.last_name.trim() : '',
        organization: typeof person.organization === 'string' ? person.organization.trim() : '',
      })),
    })),
    people: [...people.values()],
  };
}

// The SQL function uses equality against trim/lower normalized emails, including inactive
// and login-disabled records. No ILIKE wildcard or unrelated-tenant matching.
export async function lookupPublicTicketMemberEmails(db, tenantId, emails) {
  if (!tenantId) fail('TENANT_REQUIRED', 'Tenant context is required.');
  const normalized = [...new Set(emails.map(normalizePublicTicketEmail))];
  if (!normalized.length || normalized.some(email => !email) || normalized.length > 101) {
    fail('INVALID_EMAILS', 'A bounded list of contact emails is required.');
  }
  const { data, error } = await db.rpc('lookup_public_ticket_member_emails', {
    p_tenant_id: tenantId, p_emails: normalized,
  });
  if (error || !Array.isArray(data)) {
    fail('ELIGIBILITY_UNAVAILABLE', 'Unable to verify ticket eligibility. Please try again before paying.', 503);
  }
  return new Set(data.map(row => row.normalized_email));
}

export async function preflightPublicTicketMembers({
  db, tenantId, authenticatedMember, purchaser, items, roles,
}) {
  const publicOnly = items.some(item => item.ticket?.visibility_mode === 'public_only');
  const snapshot = buildPublicTicketMemberSnapshot({ tenantId, purchaser, items, roles });
  if (!publicOnly && !snapshot) return null;
  if (authenticatedMember?.tenant_id === tenantId) {
    fail('PUBLIC_ONLY_MEMBER', 'Members cannot purchase Public only tickets. Choose a member ticket.', 403);
  }
  const buyerEmail = normalizePublicTicketEmail(purchaser?.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(buyerEmail)) {
    fail('INVALID_EMAIL', 'Provide a valid purchaser email before payment.');
  }
  const existing = await lookupPublicTicketMemberEmails(db, tenantId, [
    buyerEmail, ...(snapshot?.people.map(person => person.identity.email) || []),
  ]);
  if (existing.has(buyerEmail)) {
    fail('PUBLIC_ONLY_MEMBER', 'Members must sign in and choose a member ticket.', 409);
  }
  if (existing.size) {
    fail('ATTENDEE_ALREADY_MEMBER', 'An attendee already has a record in this tenant. Choose a member ticket for that attendee.', 409);
  }
  return snapshot;
}
