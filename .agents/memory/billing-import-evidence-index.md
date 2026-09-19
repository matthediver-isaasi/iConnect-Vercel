# Billing, import, and evidence topics

- [csv_import_job history](csv-import-job-history.md) — import history writes are swallowed by try/catch so column drift fails silently; recording must fire on BOTH the SQL fast path and JS path, and the list must be tenant-filtered.
- [Member/org import pitfalls](member-import-pitfalls.md) — import SQL fast path silently drops non-core fields; preference_value column is `field_id`; emails must be stored lowercased or login shows "No Member Record".
- [Accounting provider dual invoice columns](accounting-provider-dual-columns.md) — QBO rows fill only accounting_invoice_id/number; queries filtering xero_* alone silently miss them; keep xero_invoice_id strictly Xero for API calls.
- [Pending-PO Xero reference heuristic](pending-po-reference-heuristic.md) — descriptive Xero References ('Training Fund top-up', 'Membership …') must be blacklisted or the PO report hides rows; PostgREST .or() fails on UPDATE.
- [BNMS renewal reconciliation](bnms-renewal-reconciliation.md) — review one exact class and twelve-month invoice window per Excel workbook; nominal-code evidence must be explicit.
- [Private report recovery](private-report-recovery.md) — exact historical attachment hashes prove report identity, not individual import writes; verify delivered bytes separately.