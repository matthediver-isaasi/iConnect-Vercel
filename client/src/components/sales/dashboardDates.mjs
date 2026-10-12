// Calendar dates are formatted directly, never interpreted in the browser timezone.
export function formatDashboardDate(value) {
  const text = String(value ?? "");
  const calendar = /^(\d{4})-(\d{2})-(\d{2})(?:$|T|\s)/.exec(text);
  if (calendar) return `${calendar[3]}/${calendar[2]}/${calendar[1]}`;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? text : date.toLocaleDateString("en-GB");
}

export function parseDashboardDate(value) {
  if (value === "") return "";
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if (!match) return null;
  const [, day, month, year] = match;
  const date = new Date(`${year}-${month}-${day}T00:00:00Z`);
  if (Number(year) < 1 || Number.isNaN(date.getTime()) ||
      date.getUTCFullYear() !== Number(year) || date.getUTCMonth() + 1 !== Number(month) ||
      date.getUTCDate() !== Number(day)) return null;
  return `${year}-${month}-${day}`;
}

export function validateExpectedCloseRange(from, to) {
  const expectedCloseFrom = parseDashboardDate(from);
  const expectedCloseTo = parseDashboardDate(to);
  if (expectedCloseFrom === null || expectedCloseTo === null) {
    return { error: "Enter valid dates in DD/MM/YYYY format." };
  }
  if (expectedCloseFrom && expectedCloseTo && expectedCloseFrom > expectedCloseTo) {
    return { error: "From date must be on or before To date." };
  }
  return { expectedCloseFrom, expectedCloseTo };
}

export function dashboardReportParams(filters) {
  const params = new URLSearchParams({ view: "dashboard", expectedCloseSort: filters.expectedCloseSort });
  for (const key of ["expectedCloseFrom", "expectedCloseTo"]) {
    if (filters[key]) params.set(key, filters[key]);
  }
  return params;
}
