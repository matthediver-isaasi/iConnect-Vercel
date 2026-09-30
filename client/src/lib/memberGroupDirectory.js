export function isMemberGroupDirectoryVisible(group) {
  return !!group
    && group.is_active !== false
    && group.hide_on_group_page !== true;
}

export function resolveHideOnGroupPage(group) {
  return group?.hide_on_group_page === true;
}