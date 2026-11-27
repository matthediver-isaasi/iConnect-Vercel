---
name: Member DD self-cancellation policy
description: Owner-confirmed rules for member-initiated Direct Debit cancellation from the portal Payment Details card.
---
- Eligible once successful collections >= the consent-time instalment count, counted across an uninterrupted DD lineage (renewals do not reset; a genuine cancellation/gap restarts).
- Effective at the end of the verified paid period, no extra grace; collections fenced at confirmation.
- Outcome applies the structure's DD fallback role, never the blanket membership_cancelled login block; admin cancellation semantics unchanged.
- Renewals keep predecessor agreements `active` and finished subscriptions leave plans `expired`; eligibility and DB admission must both treat these as normal, not as competing or outstanding.
- Member-mode requests cannot be withdrawn; late receipts go to manual review and never reactivate.
**Why:** owner confirmed these in the task brief; the existing admin cancellation blocks login entirely, which this mode must not do.
**How to apply:** any change to cancellation guards/readers must branch on request mode. The member-mode migration is not in the pinned foundation installer; the owner approved it and it was installed on live DEST on 2026-11-27, so the readiness probe now returns true there. Any later change to it needs its own new migration, never a replay.
