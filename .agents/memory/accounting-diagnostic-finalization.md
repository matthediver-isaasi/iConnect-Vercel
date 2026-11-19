---
name: Accounting diagnostic finalization
description: Successful provider settlement can be followed by a diagnostic-cleanup failure.
---
Treat provider settlement, persisted settlement progress, and diagnostic cleanup as separate evidence when recovering a paid membership.

**Why:** A recovery successfully created and paid the Xero invoice and persisted settlement completion, then failed while clearing an old note. The outer handler marked the history as failed despite the successful financial outcome. Retrying invoice creation in that situation would risk duplication.

**How to apply:** Check the provider balance and authoritative settlement progress before attempting another financial action. JSONB string comparisons through PostgREST require valid JSON encoding even though the database client returns a plain JavaScript string; test diagnostic cleanup against the real column type, not just an in-memory mock.

Do not use whole-Xero-contact equality to prove that invoicing left contact
identity unchanged.

**Why:** Issuing an invoice legitimately changes a contact's derived balances
and may change its update timestamp. A whole-row hash can fail after invoice
creation and linkage have already succeeded, without any contact-identity write.

**How to apply:** Deny contact writes at the transport boundary and compare
identity/address fields separately from balances and timestamps. If a final
audit fails, inspect the persisted invoice result before attempting recovery
again.
