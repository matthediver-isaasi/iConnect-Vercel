# Sales reconciliation operations

## Release checklist and verification

- [ ] Run `npm run test:sales-hardening` and `npm run build`.
- [ ] Deploy the Sales schema migrations in this order:
  1. `20260907_sales_foundation.sql`
  2. `20260908_sales_catalogue.sql`
  3. `20260909_sales_quotes.sql`
  4. `20260910_sales_commercial_allocation.sql`
  5. `20260911_sales_quote_delivery.sql`
  6. `20260912_sales_accounting_invoice.sql`
  7. `20260912_sales_allocation_delegate_registration.sql`
  8. `20260913_sales_concurrency_hardening.sql`

  Apply every migration with stop-on-error enabled and retain its output. Do not
  deploy application code that writes a later table or RPC before its migration
  succeeds.
- [ ] Deploy the API, then call `GET /api/sales/reconciliation?limit=100` as a
   tenant Sales reports user. A `200` response with `total: 0` is the normal
   clean baseline. The endpoint is read-only and scans at most 50,000 rows per
   source; a `413` means the tenant must be investigated with targeted SQL.
- [ ] Confirm a sale, reconcile one confirmed delegate booking, and (where an
   accounting provider is configured) create or refresh an invoice. Re-run the
   scanner and confirm no new error findings. Retain the response and migration
   version in the release record.

## Monitoring and recovery

Run the scanner after deployment and daily for active Sales tenants. Alert on
any `error` finding and on warnings that remain across two scans:

| Finding | Meaning | Recovery |
|---|---|---|
| `ALLOCATION_*` | Append-only allocation movements no longer balance. | Stop affected allocation changes; compare movement history and booking links, then escalate with IDs. |
| `ACTIVE_ALLOCATION_BOOKING_NOT_CONFIRMED` / `ALLOCATION_BOOKING_SOURCE_MISMATCH` | A current designation lacks its matching confirmed booking. | Use the existing idempotent booking cancellation/unreconciliation or reconciliation flow; never update the link or movement rows. |
| `INVOICE_SALE_SOURCE_MISMATCH` | Invoice source linkage drift. | Stop invoice operations and escalate; source fields are deliberately immutable. |
| `STALE_INVOICE_ATTEMPT` | Provider conversion claim is older than ten minutes. | Retry the normal invoice command. It reuses the durable provider idempotency key. |
| `STALE_CUSTOMER_MAPPING_CLAIM` | Provider customer claim is older than ten minutes. | Retry the normal invoice command; it reclaims or completes the mapping safely. |

Monitor API 5xx/413 rates and scanner error/warning counts by tenant. A clean
scan alone does not prove provider delivery: also monitor provider/API failures
and invoice-status refresh outcomes. Monitor `429` responses from public quote
links separately; the shared limiter uses one-minute windows and automatically
cleans counters that have been idle for more than one day.

## Rollback boundaries

Schema migrations add immutable records, functions, and constraints; they are
not safely reversible after commercial sales, movements, booking links, or
provider invoices have been created. Roll back application traffic by disabling
Sales access or reverting API code, but **do not** drop Sales tables/functions
or mutate append-only records. Preserve the scanner output, sale/allocation/
invoice IDs, provider idempotency key, and migration version for incident
recovery. Resume writes only after a clean targeted scan and an operator has
verified the affected booking or provider invoice through the supported flow.