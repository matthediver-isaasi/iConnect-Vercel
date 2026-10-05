import { publicTicketMemberPolicy } from '../../../shared/publicTicketMemberPolicy.js';
export const isProvisionableRole = role => !!role
  && !role.is_admin && !role.is_tenant_admin && !role.requires_effective_from_date
  && role.max_members == null && !role.requires_organization;

export function ticketMemberPolicy(ticket = {}) {
  return publicTicketMemberPolicy(ticket);
}

export function updateTicketMemberField(ticket, field, value) {
  return field === "visibility_mode" && value !== ticket.visibility_mode
    ? { ...ticket, [field]: value, create_member_records: false, new_member_role_id: null }
    : { ...ticket, [field]: value };
}

export function validateTicketMemberPolicies(tickets, roles) {
  return tickets.filter(ticket => ticketMemberPolicy(ticket).create_member_records
    && !roles.some(role => String(role.id) === String(ticket.new_member_role_id) && isProvisionableRole(role)))
    .map(ticket => `Select an eligible role for new members on "${ticket.name || "Unnamed ticket"}".`);
}

export function purchaseIdentity(person = {}) {
  return {
    first_name: String(person.first_name || "").trim(),
    last_name: String(person.last_name || "").trim(),
    email: String(person.email || "").trim().toLowerCase(),
    organization: String(person.organization || "").trim(),
  };
}

export function validatePurchaseIdentities(purchaser, items) {
  // UX-only validation. The server must reload ticket policy and resolve roles
  // from tenant-owned tickets; no client provisioning fields are authoritative.
  const enabledItems = items.filter(item => ticketMemberPolicy(item.ticketClass).create_member_records);
  if (!enabledItems.length) return null;
  const identities = new Map();
  const add = (person, role, label) => {
    const identity = purchaseIdentity(person);
    if (!identity.first_name || !identity.last_name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identity.email) || !identity.organization) {
      return `Please provide first name, last name, a valid email and organisation for ${label}.`;
    }
    const existing = identities.get(identity.email);
    if (existing && existing.role !== String(role)) return "The same person cannot receive different new-member roles in one purchase. Please use tickets with the same role or make separate purchases.";
    if (existing && ["first_name", "last_name", "organization"].some(key => existing.identity[key] !== identity[key])) {
      return "The same email has conflicting identity details. Please correct the purchaser and attendee details.";
    }
    identities.set(identity.email, { role: String(role), identity });
    return null;
  };
  for (const item of enabledItems) {
    const role = item.ticketClass.new_member_role_id;
    const buyerError = add(purchaser, role, "the purchaser");
    if (buyerError) return buyerError;
    for (const attendee of item.attendees) {
      const error = add(attendee, role, "each attendee receiving this ticket");
      if (error) return error;
    }
  }
  return null;
}
