---
name: Members can register others (event setting)
description: Owner rule for the per-event setting limiting members to booking only their own place.
---

Per-event boolean on simple and complex events, default allowed. When off, a signed-in
member's booking may contain only themselves; non-members are unaffected; admin/manual
booking tools are unaffected; allocation-invitation delegates are exempt (identity is fixed
by the invitation).

**Why:** owner request (2026-11-27): some events must stop members registering colleagues
or externals. Defaulting to allowed preserves behaviour of every existing event.

**How to apply:** any new member booking path (simple, programme, complex, funnel) must call
the shared self-only check before booking. Where a card payment may already have been taken,
raise it through the existing credit-policy compensation block so the charge is reversed,
never as a bare early return. Group events are already self-only, so group admins neither
see nor write this field.
