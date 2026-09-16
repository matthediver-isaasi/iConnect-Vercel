/** Parse a vacancy.closing_date (YYYY-MM-DD or ISO) to a Date, or null. */
export function getClosingDate(vacancy) {
  const raw = vacancy?.closing_date;
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Preserve the vacancy cards' local, whole-day deadline comparison. */
export function isClosingDatePast(vacancy, now = new Date()) {
  const d = getClosingDate(vacancy);
  if (!d) return false;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const closing = new Date(d);
  closing.setHours(0, 0, 0, 0);
  return closing < today;
}

export function isVacancyClosed(vacancy, now = new Date()) {
  return vacancy?.status === "closed" || isClosingDatePast(vacancy, now);
}

export function countOpenVacanciesByGroup(vacancies, now = new Date()) {
  const byGroup = {};
  for (const vacancy of vacancies) {
    if (vacancy.member_group_id && vacancy.status === "open" && !isVacancyClosed(vacancy, now)) {
      byGroup[vacancy.member_group_id] = (byGroup[vacancy.member_group_id] || 0) + 1;
    }
  }
  return byGroup;
}