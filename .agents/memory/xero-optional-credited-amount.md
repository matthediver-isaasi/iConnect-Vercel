---
name: Xero invoice response semantics
description: Optional credited amounts and retained outstanding amounts on verified voids.
---

Xero can omit `AmountCredited` entirely even on a successful single-invoice
GET for an authorised invoice with zero paid and the entire total outstanding.
Do not assume every documented monetary property is present because fixtures
include it.

**Why:** A read-only check of the reported unpaid invoice confirmed this omission;
requiring the field prevented an otherwise valid cancellation preview.

**How to apply:** Distinguish an absent optional credit field from a supplied
null or malformed value. Independently verify zero paid, the full outstanding
balance, no credit/payment allocations and the original purchase totals.
Required monetary fields remain mandatory. Test both preview and recovery from
a verified void with the optional field absent; do not default arbitrary
missing accounting evidence to zero.

A Xero `VOIDED` invoice can retain its full original `AmountDue`; voiding does
not guarantee that this field becomes zero.

**Why:** A live read confirmed a successfully voided, wholly unpaid invoice whose
outstanding amount still equalled the original total. Requiring zero stranded
the local cancellation after the provider void had already succeeded.

**How to apply:** For recovery of an already approved wholly unpaid invoice,
accept only zero or the exact original gross outstanding amount alongside
verified `VOIDED` status, matching identity/totals and no payments or credit
allocations. Reject partial, changed or malformed balances. Preserve the actual
provider amount in the receipt rather than rewriting it to zero. Reading an
existing void must not submit another provider void.
