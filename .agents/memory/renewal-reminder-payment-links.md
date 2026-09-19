---
name: Renewal reminder payment quotes
description: Preserve the same successor quote across reminders, public checkout and asynchronous reconciliation.
---

Payment-link reminders must prepare a fee token without invoking fee-email delivery. Use the saved successor quote throughout checkout and background reconciliation, not only the public page.

**Why:** A webhook may complete before the browser callback. If only the browser honors the quote, that race can activate an early renewal immediately or reconstruct different pricing.

**How to apply:** Keep both completion paths aligned on committed term dates and amounts. Defer reminders outside the opening window without recording them as sent, and substitute bearer links only after template-render diagnostics so they never enter logs.