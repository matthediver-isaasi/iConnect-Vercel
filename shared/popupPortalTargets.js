// Explicit opt-in only. Never derive this list from the administrative router.
export const POPUP_PORTAL_TARGETS = Object.freeze([
  ['Events', 'Events', 'page_user_Events'],
  ['Bookings', 'Bookings', 'page_user_Bookings'],
  ['MyTickets', 'My tickets', 'page_user_MyTickets'],
  ['Resources', 'Resources', 'page_user_Resources'],
  ['Articles', 'Articles', 'page_user_Articles'],
  ['News', 'News', 'page_user_News'],
  ['MemberDirectory', 'Member directory', 'page_user_MemberDirectory'],
  ['OrganisationDirectory', 'Organisation directory', 'page_user_OrganisationDirectory'],
  ['MyOrganisation', 'My organisation', 'page_user_MyOrganisation'],
  ['Team', 'My team', 'page_user_Team'],
  ['Balances', 'Balances', 'page_user_Balances'],
  ['History', 'History', 'page_user_History'],
  ['CpdPoints', 'CPD points', 'cpd.member_cpd'],
  ['Preferences', 'About me', 'page_user_Preferences'],
  ['Support', 'Support', 'page_user_Support'],
  ['Forum', 'Forum', 'forum'],
].map(([key, label, feature]) => Object.freeze({ key, label, feature })));

export function popupPortalTarget(key) {
  return POPUP_PORTAL_TARGETS.find(target => target.key === key) || null;
}

export function popupPortalTargetForPath(pathname) {
  const path = pathname.replace(/\/+$/, '').toLowerCase();
  if (['/about-me', '/aboutme'].includes(path)) return popupPortalTarget('Preferences');
  return POPUP_PORTAL_TARGETS.find(target => path === `/${target.key.toLowerCase()}`) || null;
}

export function popupTargetRequest(page) {
  return page.portal_key ? { portal_page: page.portal_key }
    : { page_id: page.id, ...(page.microsite_id ? { microsite_id: page.microsite_id } : {}) };
}
