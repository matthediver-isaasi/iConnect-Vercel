import { buildRollingTerm } from '../../shared/rollingMembershipTerm.js';

export function rollingMembershipWindow(config, startDate, previousTerm = null) {
  const term = buildRollingTerm({
    startDate: previousTerm?.membership_renewal_date || startDate,
    billingPeriod: config.billing_period,
    anchorDate: previousTerm?.term_anchor_date,
    previousTerm,
  });
  return {
    label: term.term_key,
    start: new Date(`${term.term_start_date}T00:00:00.000Z`),
    end: new Date(`${term.term_end_date}T00:00:00.000Z`),
    ...term,
  };
}

export function calculateMembershipYearWindow(config, referenceDate = new Date()) {
  if (config && config.start_mode === 'immediate') {
    return rollingMembershipWindow(config, referenceDate);
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
    return rollingMembershipWindow(config, nextStart, current);
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
