---
name: Allocated delegate claim ordering
description: Transaction boundary for Event bookings that consume a commercial allocation invitation.
---

An allocated delegate invitation must remain reserved while the ordinary Event booking passes its final capacity checks. Claim the entitlement only after those checks, but before confirmation emails, reminders, or other irreversible success side effects.

**Why:** A late capacity rejection after claiming strands entitlement against a deleted booking. Conversely, a failed claim after a multi-item paid checkout can leave uncovered extras charged or confirmed unless the entire booking group is compensated.

**How to apply:** In every simple or complex Event registration path, treat booking creation, allocation claim, and checkout compensation as one logical unit. On claim failure, remove the whole new booking group, restore capacity exactly once, reverse internal balances/vouchers, and idempotently refund external card payment.