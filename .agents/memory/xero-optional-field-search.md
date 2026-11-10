---
name: Xero optional-field searches
description: Provider query validation requires null guards before string operations.
---

Xero contact searches must null-guard optional fields before invoking string methods, including each independent branch in an OR expression.

**Why:** The live API rejects an unguarded EmailAddress.ToLower() with HTTP 400 and “Operations on optional fields must be preceded by a null guard.” This can block checkout even when the accounting connection is healthy.

**How to apply:** Use `(EmailAddress!=null&&EmailAddress.ToLower()==...)` and equivalent guarding for other fields. Preserve exact identity, ambiguity, archive and pagination checks; never interpret a rejected lookup as proof a customer does not exist.
