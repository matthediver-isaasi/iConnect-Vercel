export function calculateMembershipYearWindow(config, referenceDate = new Date()) {
  if (config && config.start_mode === 'immediate') {
    const start = new Date(referenceDate);
    start.setHours(0, 0, 0, 0);
    const year = start.getFullYear();
    const end = new Date(start);
    end.setFullYear(end.getFullYear() + 1);
    end.setDate(end.getDate() - 1);
    return {
      label: `${year}/${year + 1}`,
      start,
      end,
    };
  }

  const startMonth = (config && config.membership_start_month) || 1;
  const startDay = (config && config.membership_start_day) || 1;
  const now = new Date(referenceDate);
  const currentYear = now.getFullYear();
  const yearStart = new Date(currentYear, startMonth - 1, startDay);

  if (now < yearStart) {
    return {
      label: `${currentYear - 1}/${currentYear}`,
      start: new Date(currentYear - 1, startMonth - 1, startDay),
      end: new Date(currentYear, startMonth - 1, startDay - 1),
    };
  }
  return {
    label: `${currentYear}/${currentYear + 1}`,
    start: yearStart,
    end: new Date(currentYear + 1, startMonth - 1, startDay - 1),
  };
}

export function calculateNextMembershipYearWindow(config, referenceDate = new Date()) {
  const current = calculateMembershipYearWindow(config, referenceDate);
  const nextStart = new Date(current.end);
  nextStart.setDate(nextStart.getDate() + 1);

  if (config && config.start_mode === 'immediate') {
    const end = new Date(nextStart);
    end.setFullYear(end.getFullYear() + 1);
    end.setDate(end.getDate() - 1);
    const ny = nextStart.getFullYear();
    return {
      label: `${ny}/${ny + 1}`,
      start: nextStart,
      end,
    };
  }

  const startMonth = (config && config.membership_start_month) || 1;
  const startDay = (config && config.membership_start_day) || 1;
  const nextYear = nextStart.getFullYear();
  return {
    label: `${nextYear}/${nextYear + 1}`,
    start: nextStart,
    end: new Date(nextYear + 1, startMonth - 1, startDay - 1),
  };
}
