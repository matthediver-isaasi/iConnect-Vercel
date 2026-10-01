---
name: Ticket release boundaries
description: Why release gating is separate from visibility, allocation entitlement and payment compensation.
---

Release scheduling gates new ticket purchases, not ticket visibility or already purchased allocation entitlement.

**Why:** Prices must remain visible before release to otherwise-entitled viewers, and a later schedule change must not revoke an existing commercial purchase. The exemption must come from a server-resolved invitation and apply only to its purchased ticket, not other items in the same cart.

**How to apply:** Keep audience filtering unchanged, then apply release eligibility to selection and financial entry points. On payment completion recheck authoritative schedules; use bound compensation rather than creating a booking or refunding an unverified payment.

Repeated DST wall-clock times require an explicit occurrence choice, while changing the display timezone preserves an already-resolved instant.

**Why:** Automatically choosing an offset or preserving the wall-clock value changes the release moment without clear author intent.

**How to apply:** Keep invalid/ambiguous draft input separate from the last valid instant and block saving until resolved or cleared, including after collapsing and reopening a ticket editor.

Compatibility verification must use the actual frontend payload for old single-price events, not only an omitted ticket identifier.

**Why:** The legacy frontend represents some events with a synthetic default selection while other legacy events have no pricing configuration. Tests using only missing IDs can pass while real users cannot pay or register.

**How to apply:** Test browser-generated payment and booking requests against the real handlers. Any legacy exception must depend on the authoritative event having no configured ticket classes; never let that representation bypass a configured ticket's release.