// Organisation display is not evidence of membership or guest-booking status.
export function registrationOrganisationName(attendee, organizations = {}) {
  const names = [
    organizations[attendee?.organization_id],
    attendee?.attendee_organization,
    attendee?.guest_organisation_name,
  ];
  return names.find(name => typeof name === 'string' && name.trim())?.trim() || '';
}

export function registrationOrganisationLabel(attendee, organizations = {}) {
  return registrationOrganisationName(attendee, organizations) || 'Not provided';
}
