# PostgREST and pagination topics

- [List pages with preference values](list-pages-preference-values.md) — fetch and filter `member_preference_value` server-side per page; client-side reads hit PostgREST's 1000-row cap.
- [PostgREST range pagination needs ORDER BY](postgrest-pagination-order.md) — every `.range()` loop needs a stable unique `.order()` or pages can skip and repeat rows.
- [Import idempotency & the 1000-row cap](import-idempotency-1000-cap.md) — full-list dedupe and diff reads must paginate so large tenants do not create duplicates on re-run.
- [Bounded list APIs and exports](bounded-list-api-exports.md) — exports that reuse capped list endpoints must follow pages through the exact reported total.
- [PostgREST large IN filters](postgrest-large-in-filters.md) — batch large UUID filters, paginate each batch deterministically, and combine results before comparison.
- [Paginated RPC exact totals](paginated-rpc-exact-totals.md) — return the filtered total independently of page rows, including when the requested page is empty.
- [Metadata compare-and-swap](postgrest-metadata-cas.md) — large JSON URL filters can return HTTP 400; use body-based atomic RPCs and distinguish errors from lost races.