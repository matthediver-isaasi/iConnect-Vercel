---
name: Sales grouped billing policy
description: User-confirmed distinction between issuance timing, payment terms, allocation and live financial rollout.
---

Invoice timing and time to pay are independent: acceptance plus calendar days or
a fixed calendar date decides eligibility; payment terms run from the actual
first issuance-attempt date. Neither a past fixed date nor moving an opportunity
to Won permits invoicing before durable proposal acceptance.

**Why:** The user explicitly confirmed this distinction rather than a single
combined “payment terms” field.

**How to apply:** Keep both commitments visible before acceptance. Preserve the
accepted timezone and dates, and never silently backdate late processing.

A deposit is an allocation of the independent bundle selling price, not an extra
charge. This scope does not authorize percentage deposits, splitting one product
between milestones, changing accepted schedules or retroactive scheduling.

**Why:** The user deliberately limited grouped billing to one-level product
groups while preserving the existing independent bundle pricing model.

**How to apply:** Treat accepted amendments, cancellations, credits and refunds
as separate approved financial workflows. Schema changes and isolated tests do
not authorize live scheduler activation, invoices or customer emails.
