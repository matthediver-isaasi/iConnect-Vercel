---
name: Non-allocating bundle receipts
description: Inventory opt-out must preserve accepted selection and payment authority.
---

Turning off bundle stock reduction only affects new allocation; it must not
remove accepted-selection evidence or alter existing checkout holds.

**Why:** Original labels, price and immutable retry terms previously depended on
allocation evidence. Simply skipping allocation would let catalogue changes
reprice or strand an already-payable checkout.

**How to apply:** Keep non-allocating selection receipts distinct from holds;
recover original terms from either evidence source, but settle and clean up only
actual allocations. Never infer historical allocation policy from today's form.

Expose the opt-out only when the database capability installed with its atomic
trigger change is present; gate author saves and new acceptance as well as UI.

**Why:** This project's database migration and application release are separate.
Without a runtime gate, old triggers silently deduct stock despite the displayed
opt-out, and new retry readers can query a table that does not exist yet.

**How to apply:** Missing capability keeps legacy behavior and blocks opt-out;
unexpected readiness errors fail explicitly. Never treat a prepared migration
or a successful application build as evidence of installed database authority.
