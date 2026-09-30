/**
 * Display/reference rules shared by the Due Diligence API and review surfaces.
 *
 * A form submission can be associated with both a member and an
 * organisation.  A member association is authoritative for member-based DD
 * labels; its organisation is only a fallback when that member no longer
 * resolves.  IDs are deliberately never used as labels.
 */

export const getDueDiligenceMemberId = (formSubmission, linkedEntityId = null) =>
  formSubmission?.created_member_id ||
  formSubmission?.member_id ||
  linkedEntityId ||
  null;

export const getDueDiligenceOrganizationId = (formSubmission, linkedEntityId = null) =>
  formSubmission?.created_organization_id ||
  formSubmission?.organization_id ||
  linkedEntityId ||
  null;

export const getDueDiligenceMemberName = (member) => {
  if (!member) return '';
  const fullName = typeof member.full_name === 'string' ? member.full_name.trim() : '';
  if (fullName) return fullName;
  const name = [member.first_name, member.last_name]
    .filter((part) => typeof part === 'string' && part.trim())
    .join(' ')
    .trim();
  return name || (typeof member.email === 'string' ? member.email.trim() : '');
};

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const stringifyReferenceValue = (value) => {
  if (value === null || value === undefined || value === '') return '';
  if (Array.isArray(value)) {
    return value.map(stringifyReferenceValue).filter(Boolean).join(', ');
  }
  if (typeof value === 'object') {
    const objectName =
      value.full_name ||
      value.name ||
      ([value.firstName, value.lastName].filter(Boolean).join(' ')) ||
      value.email;
    if (objectName) return String(objectName);
    try {
      return JSON.stringify(value);
    } catch {
      return '';
    }
  }
  return String(value);
};

/**
 * Resolve the visible DD reference.  `memberId` is kept separate from
 * `organizationId` so a member UUID can never be looked up in the
 * organisation table by accident.
 */
export const getDueDiligenceReferenceLabel = ({
  member = null,
  memberId = null,
  organization = null,
  organizationId = null,
  applicationLevel = 'member',
  cardReferenceField = null,
  configuredValue,
  formValues = {},
  applicationUid = '',
} = {}) => {
  const memberName = getDueDiligenceMemberName(member);
  const organizationName =
    typeof organization?.name === 'string' ? organization.name.trim() : '';
  const organizationApplication = String(applicationLevel || '').toLowerCase() === 'organization';
  const blockedIds = new Set(
    [memberId, organizationId].filter(Boolean).map((value) => String(value)),
  );
  const safeString = (value, { allowApplicationReference = false } = {}) => {
    const display = stringifyReferenceValue(value).trim();
    const isApplicationReference =
      allowApplicationReference && /^DD-/i.test(display);
    return display && !blockedIds.has(display)
      && (isApplicationReference || !UUID_RE.test(display))
      ? display
      : '';
  };
  const configured = safeString(configuredValue);
  const savedOrganization = [
    formValues.organization_name,
    formValues.company_name,
  ]
    .map((value) => safeString(value))
    .find(Boolean) || '';
  const savedMember = [
    formValues.member_name,
    formValues.memberName,
    formValues.name,
    formValues.email,
  ]
    .map((value) => safeString(value))
    .find(Boolean) || '';

  // A custom card reference remains authoritative for organisation forms.
  // The built-in organisation reference, however, is selected from the
  // application-level entity rather than from whichever ID happens to exist.
  if (organizationApplication) {
    if (cardReferenceField && cardReferenceField !== '__organization_name__' && configured) {
      return configured;
    }
    if (organizationName) return organizationName;
    // Preserve a saved organisation answer when the linked organisation was
    // deleted, before falling back to a contact created by the application.
    if (savedOrganization) return savedOrganization;
    // An organisation application can still have a created contact/member.
    // That contact is only a fallback when the organisation itself is missing.
    if (memberName) return memberName;
    if (savedMember) return savedMember;
  } else if (memberName) {
    // Member applications must show the member even when it has an
    // organisation and the configured field is the organisation name.
    return memberName;
  } else {
    // A deleted member should not cause its organisation to mask a saved
    // member/contact value from the submitted form.
    if (configured) return configured;
    if (savedMember) return savedMember;
    if (organizationName) return organizationName;
    if (savedOrganization) return savedOrganization;
  }

  if (cardReferenceField === '__organization_name__' && organizationName) {
    return organizationName;
  }

  if (cardReferenceField && configured) return configured;

  for (const value of [
    organizationName,
    savedOrganization,
    savedMember,
    applicationUid,
  ]) {
    const display = safeString(value, { allowApplicationReference: value === applicationUid });
    if (display) return display;
  }
  return '';
};
