---
name: Public Invoice / PO intentions
description: Why record-only registrations must remain separate from invoicing and attendee membership.
---

Public Invoice / PO is a registration intention, not an invoice or a receivable. Do not introduce collection, invoice recovery, accounting contacts, or automatic conversion as an incidental extension of booking processing.

The owner now authorises a separate, explicit administrator **Generate invoice**
action after the original booker has a member account. It is one invoice for the
whole booking, billed to the original booker—not separate attendee invoices.
Creating an attendee account alone must never trigger invoicing.

After an administrator-approved public PO invoice is successfully created, it
must be emailed automatically to the original booker.

**Why:** The owner clarified that successful invoice creation must include
delivery to the booker; merely creating the receivable in Xero/QB is insufficient.

**How to apply:** Send after confirmed accounting creation, not merely queue
acceptance. Preserve the original booker as recipient, avoid duplicate sends on
worker retries, and keep record-only registration and member creation email-free.

Do not bulk-email existing invoice approvals when enabling automatic delivery.
Previously created invoices require explicit delivery review or scoped approval.

**Why:** The rollout approval covered new automatic delivery and one specifically
approved existing invoice, not unsolicited retrospective delivery to all bookers.

**How to apply:** Keep historical approvals outside the automatic send queue.
Uncertain provider acceptance must require review, not a blind retry; an accepted
invoice email is not evidence that the invoice has been paid.

Invoice approval must not rewrite the immutable purchaser context, even to add
an approval identifier. Keep approval authority separate from historical identity.

**Why:** The live purchaser-context trigger rejects metadata additions too; an
isolated billing fixture without that trigger can pass while production fails.

**How to apply:** Include the real purchaser immutability guard in invoice
conversion tests. Preserve it rather than relaxing it to permit billing metadata.

**Why:** The owner confirmed that multi-attendee bookings remain the original
booker's financial responsibility. Invoice creation records no payment; settlement
is performed externally and checked against the accounting package.

**How to apply:** Preserve original registration/purchaser evidence and require
reviewed whole-booking approval before converting an intention into an invoice.
Use durable duplicate prevention, retain the record in the public-PO report, and
link the receivable to the original booker independently of attendee membership.

**Why:** The user deliberately replaced a broader account/affiliation workflow with a record-only option. A distinct method name alone is insufficient: older accounting paths can be selected by remaining balance rather than payment method.

**How to apply:** Exclude this method explicitly at financial side-effect boundaries. Preserve confirmed registration/capacity independently of unpaid settlement. Purchaser classification is checkout-time evidence, not the attendee's current membership; later attendee account linkage must neither reclassify the purchase nor make it vanish from reporting.

An apparently missing public registration can be an unchanged report query rather than a failed booking.

**Why:** React Query hashes report filters by value. Setting a new filter object with the same values does not refetch an already-mounted report, even with `staleTime: 0`; this app also disables window-focus refetch globally.

**How to apply:** Explicitly refetch when Generate Report repeats the applied filters. Before attempting data recovery, check the tenant-scoped booking and report projection separately; an existing confirmed record-only booking must not be recreated or financially converted to make it visible.

Historical standard public Invoice / PO registrations cannot prove pre-offer list prices from their stored ticket amount.

**Why:** The booking writer divided the offer-adjusted total across attendees, and did not persist the original gross price or offer snapshot. A stored amount can equally represent an undiscounted ticket or a BOGO/bulk-discounted share. Today's editable catalogue is not historical evidence.

**How to apply:** Report known discounted totals, but explicitly mark gross price and discount unavailable without authoritative historical evidence. Do not silently reconstruct from current ticket settings, and do not expand report-only fixes into checkout changes or backfills.