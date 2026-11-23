---
name: QuickBooks tax evidence
description: Preserve issued tax amounts rather than inferring overridden taxes from returned percentages.
---

Use issued tax amounts and original tax-rate references as financial evidence;
do not reconstruct overridden tax from the percentage returned by QuickBooks.

**Why:** Intuit's global-tax documentation shows an override at 10% returning
the configured 20% percentage alongside the overridden amount. Its credit-memo
reference permits supplying transaction tax detail. A percentage is therefore
not sufficient evidence of the charged tax.

**How to apply:** Preserve original issued totals and all applicable TaxRateRefs,
use explicit tax amounts for proportional credits, and verify returned monetary
amounts. Provider rejection must remain visible; never silently substitute
current tax settings or retry a possibly successful credit creation.

References checked 2026-11-23:
- https://developer.intuit.com/app/developer/qbo/docs/workflows/calculate-sales-tax/automated-sales-tax-for-non-us-locales
- https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/creditmemo
