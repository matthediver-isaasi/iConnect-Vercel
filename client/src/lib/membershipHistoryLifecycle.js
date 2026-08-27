function membershipYearStart(label) {
  const match = String(label || '').match(/^(\d{4})(?:\s*\/\s*(\d{4}))?$/);
  return match ? Number(match[1]) : null;
}

export function getMembershipHistoryLifecycle(record, currentMembershipYear) {
  const recordYear = String(record?.membership_year || '');
  const currentYear = String(currentMembershipYear || '');

  if (recordYear && recordYear === currentYear) {
    return { key: 'current', label: 'Current', variant: 'secondary' };
  }

  const recordStart = membershipYearStart(recordYear);
  const currentStart = membershipYearStart(currentYear);
  if (recordStart !== null && currentStart !== null) {
    if (recordStart < currentStart) {
      return { key: 'historical', label: 'Historical', variant: 'outline' };
    }
    if (recordStart > currentStart) {
      return { key: 'scheduled', label: 'Scheduled', variant: 'outline' };
    }
  }

  if (record?.status === 'scheduled') {
    return { key: 'scheduled', label: 'Scheduled', variant: 'outline' };
  }

  return { key: 'historical', label: 'Historical', variant: 'outline' };
}