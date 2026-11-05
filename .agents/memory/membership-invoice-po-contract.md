---
name: Membership invoice PO contract
description: The cross-provider rule for membership invoice PO/reference fields.
---

Membership invoice PO/reference fields must contain either the genuine supplied PO value alone or exactly `TBC`. Never use a membership-year description as the fallback, and normalize at the accounting-provider boundary so every entry point behaves consistently.

**Why:** The purchase-order reminder workflow uses the provider field to identify invoices still awaiting a PO. Descriptive membership-year fallbacks make those invoices disappear from that workflow.

**How to apply:** Any membership invoice path or accounting provider must preserve a genuine PO, convert blank/placeholder/legacy descriptive values to `TBC`, and leave non-membership invoice references unchanged.

Internal recovery identities must not be appended to the PO/reference, including by durable accounting queues.

**Why:** The owner's PO report matches exactly `TBC`; adding a technical suffix breaks that workflow even if the reference starts with `TBC`.

Admin membership invoicing must let the administrator choose who is billed separately from which linked record supplies the address.

**Why:** The owner explicitly chose administrator control rather than always billing either the member or their organisation. Reusing an organisation address alone does not establish that the organisation owes the invoice.

**How to apply:** Preview the recipient and selected address before confirmation, preserve the choice for retries, and warn that accounting-contact address updates can affect other invoices for that contact.