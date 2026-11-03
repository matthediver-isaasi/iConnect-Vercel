---
name: Stripe payout reporting policy
description: BNMS payout report scope and historical matching claims.
---

BNMS payout reconciliation is read-only reporting, not authority to repair
historical records, alter Stripe metadata or post anything to Xero. Do not
promise complete historical invoice matching without actual read-only coverage
evidence. Multiple invoices against one payment must not imply an allocation.

**Why:** The owner explicitly separated bank payout reconciliation from ledger
actions and stated that BNMS live historical linkage completeness was unverified.

**How to apply:** Preserve unmatched and ambiguous evidence. Keep any proposed
live coverage sampling read-only, with private exports out of source control.
Ask separately before any financial correction or metadata backfill.

For payout customer names, authority is the exact Xero invoice's `Contact.Name`,
not local member, attendee or organisation labels and not nominal accounts.
Bounded invoice reads and normal credential refresh are permitted; accounting
record writes remain outside reporting authority.

**Why:** The owner explicitly distinguished the invoice customer/contact from
ledger names and disallowed guessed names when provider evidence is unavailable.

**How to apply:** Keep name availability separate from payment matching and
Stripe retrieval completeness, retain each invoice/name association, and use
the original invoice for refunds without implying a credit note or allocation.

Modern Stripe charge responses may omit the invoice reference even for paid
subscription invoices. Resolve the exact paid InvoicePayment relationship by
PaymentIntent, not by customer, subscription, date or amount.

**Why:** Live monthly collections had valid local accounting evidence but
appeared unmatched because payout charges did not carry the invoice reference.

**How to apply:** Preserve tenant/account and live/test boundaries; incomplete
provider lookups are retrieval failures, not proof of no invoice. Never choose
one invoice arbitrarily when a payment has multiple invoice relationships.
