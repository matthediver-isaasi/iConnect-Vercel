---
name: Accounting provider dual invoice columns
description: xero_* vs accounting_* invoice columns — QBO rows populate only accounting_*, so any query filtering on xero_* silently misses them
---

Rows created by accounting-provider-aware flows store the invoice in `accounting_invoice_id` / `accounting_invoice_number` (provider-agnostic) and mirror into `xero_invoice_id` / `xero_invoice_number` ONLY when provider === 'xero'. Any report/lookup/reconciliation filtering solely on the xero_* columns silently excludes QuickBooks-billed rows.

**Why:** The pending purchase orders report never showed QBO-billed training fund purchases because its filters and invoice-key matching only checked xero_* columns.

**How to apply:**
- New queries on tables with both column pairs (e.g. `training_fund_purchase`) must match EITHER pair. Use `.or('xero_invoice_id.eq.X,accounting_invoice_id.eq.X')` on SELECT — but never `.or()` on UPDATE (PostgREST rejects it); update per-id instead.
- Keep `xero_invoice_id` strictly Xero in any code that calls the Xero API with it — QBO ids must never reach Xero endpoints. Carry a separate accounting id and pass both `invoiceId` and `xeroInvoiceId` to `provider.pushPurchaseOrder` (QBO reads invoiceId, Xero reads xeroInvoiceId).
- Invoice NUMBERs are display-only, safe to fall back xero → accounting.
