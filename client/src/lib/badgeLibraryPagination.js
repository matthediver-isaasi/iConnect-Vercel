export const BADGE_PAGE_SIZE = 12;

export function badgeListOptions({ search, status, page }) {
  const filter = {};
  if (search) {
    // PostgREST rewrites every * in ilike to %, even escaped ones.
    // Its case-insensitive regex operator preserves literal stars.
    filter.name = search.includes("*")
      ? { imatch: search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") }
      : { ilike: `%${search.replace(/[\\%_]/g, "\\$&")}%` };
  }
  if (status !== "all") filter.is_active = status === "active";
  return {
    filter,
    sort: { created_date: "desc", id: "desc" },
    limit: BADGE_PAGE_SIZE,
    offset: (page - 1) * BADGE_PAGE_SIZE,
    queryParams: { count: "exact" },
  };
}

export function badgePageNumbers(page, pageCount) {
  const start = Math.max(1, Math.min(page - 2, pageCount - 4));
  return Array.from({ length: Math.min(5, pageCount) }, (_, i) => start + i);
}