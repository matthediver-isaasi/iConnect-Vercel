---
name: Membership invoice PO contract
description: The cross-provider rule for membership invoice PO/reference fields.
---

Membership invoice PO/reference fields must contain either the genuine supplied PO value alone or exactly `TBC`. Never use a membership-year description as the fallback, and normalize at the accounting-provider boundary so every entry point behaves consistently.

**Why:** The purchase-order reminder workflow uses the provider field to identify invoices still awaiting a PO. Descriptive membership-year fallbacks make those invoices disappear from that workflow.

**How to apply:** Any membership invoice path or accounting provider must preserve a genuine PO, convert blank/placeholder/legacy descriptive values to `TBC`, and leave non-membership invoice references unchanged.