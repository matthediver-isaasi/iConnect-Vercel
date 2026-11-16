---
name: Xero tracking whitespace
description: Provider normalization can cause false invoice-evidence mismatches.
---
Xero may return a tracking option without leading whitespace that was present in the submitted project code.

**Why:** Live invoice review found successful invoices whose only financial-verification mismatch was a leading space in the saved tracking option. Totals, dates, tax, account, descriptions, reference and customer matched.

**How to apply:** Investigate provider-current tracking before retrying creation. A known invoice must be verified and linked rather than recreated. Any normalization fix should be narrowly limited to proven formatting differences, not fuzzy option matching or weakened financial validation.
