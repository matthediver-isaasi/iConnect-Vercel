---
name: Event-card attendee count states
description: Display and security rules for active-attendee totals on administrative event-card actions.
---

An attendee action may show a numeric total only when the secured count query returned that event’s value. Zero is a valid resolved count; loading and unavailable are distinct states. Never use the old people icon or a default zero for an unresolved result.

**Why:** An icon fallback concealed missing count wiring after the count feature shipped, while defaulting missing/error responses to zero would falsely tell administrators an event has no attendees.

**How to apply:** Every attendee-enabled card variant must pass the secured query’s value, loading state, and error state into the shared display contract. Keep the existing server permission and cancelled-booking rules, and update cached totals when attendee data changes.