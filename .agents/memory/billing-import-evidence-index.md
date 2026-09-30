# Billing, import, and evidence topics

- [csv_import_job history](csv-import-job-history.md) — import history writes are swallowed by try/catch so column drift fails silently; recording must fire on BOTH the SQL fast path and JS path, and the list must be tenant-filtered.
- [Member/org import pitfalls](member-import-pitfalls.md) — import SQL fast path silently drops non-core fields; preference_value column is `field_id`; emails must be stored lowercased or login shows "No Member Record".
- [Accounting provider dual invoice columns](accounting-provider-dual-columns.md) — QBO rows fill only accounting_invoice_id/number; queries filtering xero_* alone silently miss them; keep xero_invoice_id strictly Xero for API calls.
- [Pending-PO Xero reference heuristic](pending-po-reference-heuristic.md) — descriptive Xero References ('Training Fund top-up', 'Membership …') must be blacklisted or the PO report hides rows; PostgREST .or() fails on UPDATE.
- [BNMS renewal reconciliation](bnms-renewal-reconciliation.md) — review one exact class and twelve-month invoice window per Excel workbook; nominal-code evidence must be explicit.
- [Private report recovery](private-report-recovery.md) — exact historical attachment hashes prove report identity, not individual import writes; verify delivered bytes separately.
- [Financial exception approvals](financial-exception-approvals.md) — manual follow-up permits only pinned exceptions, never settlement or a general financial-check bypass.
- [Financial exception evidence](financial-exception-evidence.md) — retain immutable full reviewed responses; a digest mismatch alone does not prove a financial change.
- [Payment report evidence](payment-report-evidence.md) — legacy pending payment mirrors may lack trustworthy mode/date evidence; retain strict checks and verify provider schedules instead.
- [Resource import audit evidence](resource-import-audit-evidence.md) — terminal execution IDs supersede proposal holds and URL-only matching; absence and execution failure are separate findings.
- [Event credit policy transitions](event-credit-policy-transitions.md) — paid recovery preserves original credits for verified compensation; visibility tests alone miss overcharges.
- [Financial dry-run boundaries](financial-dry-run-boundaries.md) — shared orchestration, no fabricated claim success, and transitive capability isolation are required for financial previews.