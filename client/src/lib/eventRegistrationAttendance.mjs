// Pending/unmatched records are not proof of absence. Mixed-session bookings
// count as attended when at least one target has confirmed attendance.
export function attendanceFilterCategory(attendee) {
  const status = attendee.attendance_status;
  if (status === 'attended' || (status === 'mixed' &&
    attendee.attendance_details?.some(detail => detail.status === 'attended'))) return 'attended';
  if (status === 'absent' || status === 'below_threshold') return 'not_attended';
  return 'unconfirmed';
}

export function filterRegistrationAttendance(groups, filter) {
  if (filter === 'all') return groups;
  return groups.map(group => ({
    ...group,
    attendees: group.attendees.filter(attendee => attendanceFilterCategory(attendee) === filter),
  })).filter(group => group.attendees.length > 0);
}
