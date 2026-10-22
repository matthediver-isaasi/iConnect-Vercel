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

API redaction alone is not sufficient protection for new billing-address
columns. Check direct database grants and policies before choosing storage.

**Why:** Read-only live inspection found browser-wide reads on the three owner
tables, including disabled RLS on member and organisation-group. New columns
would inherit that exposure.

**How to apply:** Require protected storage or a separately reviewed access
change before rollout; do not silently tighten unrelated existing table access.

Use protected separate storage, presented as core invoicing fields in the UI.

**Why:** The owner selected this approach instead of changing existing tables'
permissions, preserving compatibility without exposing new billing data.

**How to apply:** Keep owner/tenant checks server-side and storage inaccessible
to browser database roles. Do not add billing columns to the public owner tables.

Members, organisations and organisation groups must each have independent core
invoicing addresses using a common provider-neutral structure.

**Why:** The owner explicitly requested independent addresses for all three.

**How to apply:** Never inherit or write an associated entity's address as a
side effect of editing a record's own address.

The owner approved selecting the invoice address before Stripe: personal
address editable with an explicit save choice; organisation address selectable
but read-only for the purchasing member. The selected transaction snapshot
controls the invoice; subsequent Stripe card-address corrections are payment-only.
Selecting an organisation postal address does not change the invoice customer.

**Why:** This replaces the earlier policy that Stripe's final address always
wins, separating invoice instructions from card security details.

**How to apply:** Implement the checkout and accounting changes separately from
the core-field foundation. Preserve historical evidence; do not reinterpret old
payments as though they used the future selector.
