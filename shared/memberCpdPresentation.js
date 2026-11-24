// Member-record presentation only: self-service CPD and ledger authority are unchanged.
export const MEMBER_CPD_DEFAULT_LABEL = 'CPD points';
// UTF-16 code units, matching the input's maxLength.
export const MEMBER_CPD_LABEL_MAX_LENGTH = 60;

export function memberCpdPresentation(settings) {
  const label = typeof settings?.member_cpd_tab_label === 'string'
    ? settings.member_cpd_tab_label.trim().slice(0, MEMBER_CPD_LABEL_MAX_LENGTH) : '';
  return {
    show_member_cpd_points: settings?.show_member_cpd_points !== false,
    member_cpd_tab_label: label || MEMBER_CPD_DEFAULT_LABEL,
  };
}

export function validateMemberCpdPresentation(settings) {
  const updates = {};
  if (Object.hasOwn(settings, 'show_member_cpd_points')) {
    if (typeof settings.show_member_cpd_points !== 'boolean') {
      throw new Error('show_member_cpd_points must be a boolean');
    }
    updates.show_member_cpd_points = settings.show_member_cpd_points;
  }
  if (Object.hasOwn(settings, 'member_cpd_tab_label')) {
    if (typeof settings.member_cpd_tab_label !== 'string') {
      throw new Error('member_cpd_tab_label must be a string');
    }
    if (settings.member_cpd_tab_label.trim().length > MEMBER_CPD_LABEL_MAX_LENGTH) {
      throw new Error(`member_cpd_tab_label must be at most ${MEMBER_CPD_LABEL_MAX_LENGTH} characters`);
    }
    updates.member_cpd_tab_label = memberCpdPresentation(settings).member_cpd_tab_label;
  }
  return updates;
}
