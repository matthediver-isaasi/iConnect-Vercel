---
name: Simple-event timing invariants
description: Durable rules for adding schedule-free timing modes to simple events across write and public-read boundaries.
---

An event timing mode that forbids schedule data must be enforced before any tenant-admin fast path in the generic event authorizer. If an incompatible training transition is part of the product flow, normalize timing back to the scheduled mode rather than leaving an invalid combination; group and complex-event exclusions remain hard boundaries.

**Why:** UI-only eligibility is bypassable, and the generic event authorizer intentionally returns early for tenant admins. A malformed persisted row can also leak stale dates or agenda data through crawler and member-indexing surfaces even after the editor is fixed.

**How to apply:** Validate the merged final row for partial writes, back the invariant with a database constraint, and defensively suppress forbidden schedule fields in every public serialization/discovery path.