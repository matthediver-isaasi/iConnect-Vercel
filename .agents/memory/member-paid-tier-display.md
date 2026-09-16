---
name: Paid member tier display
description: Separate historical paid membership evidence from authority to calculate future pricing.
---

A form can resolve a paid membership structure without persisting the corresponding selector on the member. A saved paid-year snapshot proves what was purchased, not which tier should price future renewals.

**Why:** Showing “no structures configured” hides a valid paid record, but injecting the old structure into future simulations can override a changed selection and expose pricing controls whose write endpoints resolve differently.

**How to apply:** Present eligible current paid snapshots read-only when live selection is unresolved; keep future calculations and mutation controls tied to real live selection. Distinguish unmatched selection from absent configuration and failed configuration reads. Do not change monthly payment semantics to repair this display.