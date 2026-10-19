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

A deposit is an allocation of the existing selling price, not an extra charge.
Preserve the grouped-bundle billing flow as an option. A separate percentage
schedule must apply to the whole proposal total, not individual bundles.

**Why:** The user confirmed that grouped billing is right as it is and explicitly
chose whole-proposal percentage scheduling as the additional mode.

**How to apply:** Treat accepted amendments, cancellations, credits and refunds
as separate approved financial workflows. Schema changes and isolated tests do
not authorize live scheduler activation, invoices or customer emails.
Keep invoice issue delays and payment terms separate for each instalment, require
percentages to total 100%, and disable the manual payment-terms field in either
scheduled mode. Never change accepted schedules retroactively.
