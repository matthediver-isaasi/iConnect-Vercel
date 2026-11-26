---
name: Xero optional credited amount
description: Single-invoice reads may omit AmountCredited when there are no credits.
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
