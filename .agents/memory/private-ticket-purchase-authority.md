---
name: Private ticket purchase authority
description: Selected-member ticket audiences govern new purchases, not previously purchased entitlements or sibling tickets.
---

Selected-member audiences are mutually exclusive with ticket role/group restrictions. Evaluate each ticket independently; an empty selected list grants nobody access, and hidden private tickets must never become guest teaser cards.

**Why:** The owner explicitly required private offers without suppressing independently eligible tickets or changing existing role/group behavior.

**How to apply:** Base new-purchase eligibility on the verified session member's canonical tenant ownership, never attendee email, submitted member IDs, or browser eligibility flags.

Previously purchased commercial allocation entitlements and existing bookings are not retrospectively revoked by audience changes.

**Why:** The owner explicitly kept historical bookings and commercial allocation policy outside the new-purchase restriction.

**How to apply:** Keep the purchased-ticket exception narrow: only the exact ticket resolved from the server-verified invitation, with a redacted display snapshot. Do not expose the allowlist or extend the exception to sibling cart items.
