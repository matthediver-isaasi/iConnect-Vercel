---
name: Speaker award timing lifecycle
description: Durable lifecycle rules when speaker badges can be awarded before event start while vouchers remain deferred.
---

Speaker badge timing and voucher timing are separate lifecycles. `on_assignment` may create the badge after the event and all speaker child rows persist, but voucher eligibility and values are always resolved at event start.

**Why:** Treating one grant status as final for both effects can either issue vouchers early or permanently suppress a voucher when configuration, membership, or organisation linkage changes before the event.

**How to apply:** Keep event-start award configurations backward compatible. Re-evaluate deferred voucher intent at event start, including prior skip outcomes, without duplicating issued vouchers.

Speaker removal and re-addition transitions must be database-serialized. A removal decision is first-write-wins, can revoke only the active badge created by that exact event, and must preserve manual badges and live entitlements from another event.

**Why:** Client-only checks and sequential updates race, can revoke the wrong provenance, and can strand cancelled grants when a speaker is re-added.

**How to apply:** Use locked server-only database transitions for removal/reactivation. Derive current speaker entitlement from all event-level, agenda, and complex-session references; one remaining reference means the speaker is still assigned.