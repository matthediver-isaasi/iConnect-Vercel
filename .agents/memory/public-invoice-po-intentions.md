---
name: Public Invoice / PO intentions
description: Why record-only registrations must remain separate from invoicing and attendee membership.
---

Public Invoice / PO is a registration intention, not an invoice or a receivable. Do not introduce collection, invoice recovery, accounting contacts, or automatic conversion as an incidental extension of booking processing.

**Why:** The user deliberately replaced a broader account/affiliation workflow with a record-only option. A distinct method name alone is insufficient: older accounting paths can be selected by remaining balance rather than payment method.

**How to apply:** Exclude this method explicitly at financial side-effect boundaries. Preserve confirmed registration/capacity independently of unpaid settlement. Purchaser classification is checkout-time evidence, not the attendee's current membership; later attendee account linkage must neither reclassify the purchase nor make it vanish from reporting.

An apparently missing public registration can be an unchanged report query rather than a failed booking.

**Why:** React Query hashes report filters by value. Setting a new filter object with the same values does not refetch an already-mounted report, even with `staleTime: 0`; this app also disables window-focus refetch globally.

**How to apply:** Explicitly refetch when Generate Report repeats the applied filters. Before attempting data recovery, check the tenant-scoped booking and report projection separately; an existing confirmed record-only booking must not be recreated or financially converted to make it visible.