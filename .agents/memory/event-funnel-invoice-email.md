---
name: Event funnel combined invoice email
description: Owner decision on how funnel invoices are emailed to purchasers.
---
One email per funnel order carrying every issued invoice PDF, sent only after all invoices are issued; never one email per invoice.

**Why:** Owner request (2026-11-27): invoices must be emailed, but collated rather than multiple messages.

**How to apply:** Recipient is the invoice contact frozen in the order snapshot, falling back to the booker. Invoice delivery only counts as delivered after the email is accepted; an uncertain send goes to review and is never resent automatically. Orders already marked delivered before installation are not emailed retroactively.
