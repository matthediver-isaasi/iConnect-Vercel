---
name: Renewal reminder payment quotes
description: Preserve the same successor quote across reminders, public checkout and asynchronous reconciliation.
---

Payment-link reminders must prepare a fee token without invoking fee-email delivery. Use the saved successor quote throughout checkout and background reconciliation, not only the public page.

**Why:** A webhook may complete before the browser callback. If only the browser honors the quote, that race can activate an early renewal immediately or reconstruct different pricing.

**How to apply:** Keep both completion paths aligned on committed term dates and amounts. Defer reminders outside the opening window without recording them as sent, and substitute bearer links only after template-render diagnostics so they never enter logs.

Existing invoice ownership must come from saved provider identity or trustworthy tenant/owner/year-linked history, never the tenant's current accounting setting. Legacy fee-token Xero-named fields may contain QuickBooks IDs.

**Why:** Older generic callers used Xero-named token arguments for both providers. Treating that label as proof can send credentials or settlement to the wrong provider after an accounting switch.

**How to apply:** Fail closed on conflicting references. Both browser and webhook completion must share invoice creation recovery, including discovery after an ambiguous provider response; a paid membership row alone does not prove its accounting settlement finished.

Complete fallible local invoice preflight before claiming a potentially attempted external creation.

**Why:** A discovery-only retry cannot recover a journal created before a failed owner/address lookup: no provider invoice ever existed to discover.

**How to apply:** Preserve the distinction between known-not-attempted and ambiguous external effects. Test reconciliation against historical database constraints, not only reduced tables or in-memory doubles.