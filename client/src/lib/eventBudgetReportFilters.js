export function buildEventBudgetReportParams(filters) {
  const params = new URLSearchParams();
  if (filters?.dateFrom) params.set("eventDateFrom", filters.dateFrom);
  if (filters?.dateTo) params.set("eventDateTo", filters.dateTo);
  for (const type of filters?.internalEventTypes || []) {
    if (typeof type === "string" && type.trim()) {
      params.append("internalEventType", type.trim());
    }
  }
  return params;
}

export function clearEventBudgetReportFilters() {
  return { dateFrom: "", dateTo: "", internalEventTypes: [] };
}