---
name: Allocated delegate claim ordering
description: Transaction boundary for Event bookings that consume a commercial allocation invitation.
---

An allocated delegate invitation must remain reserved while the ordinary Event booking passes its final capacity checks. Claim the entitlement only after those checks, but before confirmation emails, reminders, or other irreversible success side effects.

**Why:** A late capacity rejection after claiming strands entitlement against a deleted booking. Conversely, a failed claim after a multi-item paid checkout can leave uncovered extras charged or confirmed unless the entire booking group is compensated.

**How to apply:** In every simple or complex Event registration path, treat booking creation, allocation claim, and checkout compensation as one logical unit. On claim failure, remove the whole new booking group, restore capacity exactly once, reverse internal balances/vouchers, and idempotently refund external card payment.

Invitation lifecycle paths must use one database lock order: invitation rows (ordered when locking several), then the source booking when applicable, then the shared ticket advisory lock.

**Why:** Taking the ticket lock before expired invitation rows can deadlock a post-expiry reservation against a claim that locked the invitation before expiry. Also, the claim's `reserved → unreserved + named` pair is a reservation conversion, not a booking unreconciliation; treating it as one prevents a later cancellation from releasing the named place.

**How to apply:** Expiry cleanup must lock all rows visible as expired before taking the ticket lock. Idempotency checks, unique movement predicates, reconciliation scans, and cancellation logic must distinguish invitation-scoped `unreserved` conversions from booking-scoped `unnamed`/`unreserved` reversals.