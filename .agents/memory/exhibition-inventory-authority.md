---
name: Exhibition inventory authority
description: User clarification of proposal event authority and exhibition rollout boundaries.
---

Use the existing proposal Event dropdown for both bundle and standalone exhibition
space selection. Do not introduce a second allocation-time event selector.
Ticket-product event associations retain their separate semantics.

**Why:** The user explicitly clarified that the brief's reference to an existing
bundle event association meant the Event dropdown on the new-proposal page;
bundles do not have that dedicated field.

**How to apply:** Filter space inventory using the verified proposal event.
Missing event context prevents selection rather than inferring it from a ticket
product. Keep requirements reusable across event-specific inventory groups.

Exhibition implementation does not authorize live sales, customer notifications,
production deployment or production database changes. Automatic hold expiry,
public stand booking and automatic refunds/release of sold inventory on
opportunity stage changes are outside scope.

**Why:** These are explicit user scope and authorization boundaries.

**How to apply:** Verify with isolated fixtures. Prepare destination-only
migrations, but obtain separate authorization before production changes or
live commercial actions.
