---
name: Structured invoice address compatibility
description: Owner's backward-compatibility requirement for future structured organisation invoice addresses.
---

Retain the existing single invoice-address field and use new structured fields
only when present. Check every invoice generation and update path that passes
the existing field before introducing this change.

**Why:** The owner explicitly requires careful backward compatibility across all
invoice creation and update paths.

**How to apply:** Audit direct creation, queued/recovery work and invoice updates,
not just the organisation editor or one provider helper. Do not interpret this
requirement as approval to overwrite accounting contacts or historical invoices.
