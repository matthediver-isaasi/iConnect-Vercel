const text = value => typeof value === 'string' ? value.trim().toLowerCase() : '';

export function registrationIdentityMatches(identity, name = '', email = '') {
  const fullName = [identity?.first_name, identity?.last_name].map(text).filter(Boolean).join(' ');
  return fullName.includes(text(name)) && text(identity?.email).includes(text(email));
}

export function registrationGroupMatches(group, name = '', email = '') {
  if (!text(name) && !text(email)) return true;
  return [
    group.booker, group.publicInvoicePurchaser,
    ...(group.purchasers || []),
    ...(group.attendees || []).map(a => ({
      first_name: a.attendee_first_name, last_name: a.attendee_last_name, email: a.attendee_email,
    })),
  ].filter(Boolean).some(identity => registrationIdentityMatches(identity, name, email));
}
