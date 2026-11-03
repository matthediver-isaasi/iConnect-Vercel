---
name: Quote-backed membership accounting
description: Paid membership quote recovery is separate from form-submission accounting and unpaid invoice creation.
---

Saved membership payment quotes do not imply that a form-submission record
exists. Paid membership recovery must retain independent accounting authority;
an existing paid history row is not evidence that its invoice was completed.

**Why:** Provider recovery can win the race against browser confirmation.
The browser's already-processed response previously skipped accounting, while
the submission-based sweep had no submission to recover.

**How to apply:** Use a dedicated paid-quote continuation with exact payment,
tenant, member, quote and amount checks. Do not weaken the ordinary unpaid
membership queue's exclusion of already-paid sources. Keep uncertain provider
writes in discovery/review, never blindly recreate invoices.

Historical zero-tax quotes may lack a provider tax code. A current explicit
schedule mapping is only a candidate: verify the provider rate preserves the
captured amount before creating an invoice.

**Why:** Omitting TaxType can let the accounting account's default add VAT.

**How to apply:** Preserve the purchased net/gross economics and fail closed
when the available code would change them.

Stripe billing-address capture helpers may update the Customer as a side effect.

**Why:** Reusing a checkout capture helper during an accounting preflight
refreshed Customer addresses unnecessarily.

**How to apply:** Read the captured charge and normalize its address directly
for accounting-only recovery and read-only investigation.
