---
name: Import batches are not purchase groups
description: Keep event-import provenance separate from purchaser grouping and verified free-ticket pricing.
---

An event import batch is not a purchase group. Independent imported registrations must retain independent booking identity, never a shared purchase-group reference just to identify their import.

**Why:** Registration reports interpret that reference as one booking and infer a booker, falsely making unrelated attendees appear purchased by the first member.

**How to apply:** Keep import evidence in retained receipts and individual references. Use the existing free-booking classification only when the source and approved ticket evidence establish a genuinely free registration; never reinterpret arbitrary imported zero defaults as free or paid evidence. Preserve IDs and linked attendance, reminders and provider registrations during repairs.
