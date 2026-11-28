// Complex events shown inside an event funnel use a single-ticket, single-
// attendee layout: the person booking picks one ticket and is the attendee.
// Outside funnels the multi-attendee cart is unchanged.

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function funnelChosenTicketId(cart) {
  const entry = Object.entries(cart || {}).find(([, item]) => item?.attendees?.length > 0);
  return entry ? entry[0] : null;
}

export function funnelAttendee(cart) {
  const id = funnelChosenTicketId(cart);
  return id ? cart[id].attendees[0] : null;
}

// The signed-in member is always the attendee; keep answers they already gave
// (job title and dietary/accessibility choices) when the ticket changes.
export function memberSelfAttendee(memberInfo, organizationInfo, previous = null) {
  return {
    dietary_selections: [], allergy_selections: [], accessibility_selections: [],
    ...(previous || {}),
    first_name: memberInfo?.first_name || '',
    last_name: memberInfo?.last_name || '',
    email: memberInfo?.email || '',
    organization: organizationInfo?.name || memberInfo?.organization || '',
    job_title: previous ? previous.job_title || '' : memberInfo?.job_title || '',
    isSelf: true,
  };
}

export function emptyGuestAttendee() {
  return { first_name: '', last_name: '', email: '', organization: '', job_title: '',
    dietary_selections: [], allergy_selections: [], accessibility_selections: [], isSelf: true };
}

// Choosing a ticket replaces any earlier choice; the funnel step accepts one
// ticket class and one attendee. Per-ticket discount codes do not apply here.
export function chooseFunnelTicket(ticketClass, attendee) {
  if (!ticketClass) return {};
  return { [String(ticketClass.id)]: { ticketClass, attendees: [{ ...attendee }] } };
}

export function updateFunnelAttendee(cart, patch) {
  const id = funnelChosenTicketId(cart);
  if (!id) return cart;
  const item = cart[id];
  return { [id]: { ...item, attendees: [{ ...item.attendees[0], ...patch }] } };
}

export function guestAttendeeIssues(attendee, { requireOrganization = false, requireJobTitle = false } = {}) {
  const issues = [];
  if (!attendee?.first_name?.trim() || !attendee?.last_name?.trim()) issues.push('Enter your first and last name.');
  if (!EMAIL.test(String(attendee?.email || '').trim())) issues.push('Enter a valid email address.');
  if (requireOrganization && !attendee?.organization?.trim()) issues.push('Enter your organisation.');
  if (requireJobTitle && !attendee?.job_title?.trim()) issues.push('Enter your job title.');
  return issues;
}
