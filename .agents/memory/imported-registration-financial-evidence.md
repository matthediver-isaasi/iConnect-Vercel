---
name: Imported registration financial evidence
description: Why imported zero amounts must not establish a free historical purchase.
---

Admin-import zero defaults are not historical checkout evidence. Treat unknown
ticket values and derived discounts/totals as unavailable, while preserving
independently supported stored amounts and explicit payment intentions.

**Why:** A production investigation confirmed that a guest import carried zero
amounts and no payment linkage, yet the report called it Free. Neither absence
of payment references nor current catalogue prices can establish what happened
outside the application.

**How to apply:** Financial reports and exports must distinguish import
provenance, recorded free checkout, and missing evidence. Any historical repair
requires separately reviewed immutable evidence, not membership or current prices.

An import batch is not evidence of a shared purchase. Give independent delegates
independent booking groups, and record batch provenance separately.

**Why:** Reusing a batch reference as the booking group made dozens of unrelated
members appear as one purchase with one inferred booker, and exposed them to
group-scoped invoice/cancellation behavior. Even an existing admin-import
endpoint's convention is not sufficient evidence of correct grouping.

**How to apply:** Group imported rows only when the source establishes a shared
booking. Verify report groups as well as row counts and attendee identities.