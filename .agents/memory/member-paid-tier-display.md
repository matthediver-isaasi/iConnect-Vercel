---
name: Paid member tier display
description: Separate historical paid membership evidence from authority to calculate future pricing.
---

A form can resolve a paid membership structure without persisting the corresponding selector on the member. A saved paid-year snapshot proves what was purchased, not which tier should price future renewals.

**Why:** Showing “no structures configured” hides a valid paid record, but injecting the old structure into future simulations can override a changed selection and expose pricing controls whose write endpoints resolve differently.

User confirmation (2026-09-16): setting the missing member class restored next-year pricing for a flat-cost structure. Flat pricing does not bypass structure-scope selection.

**How to apply:** Present eligible current paid snapshots read-only when live selection is unresolved; keep future calculations and mutation controls tied to real live selection. Distinguish unmatched selection from absent configuration and failed configuration reads. Do not change monthly payment semantics to repair this display.

## Legacy grace display is not a historical commitment repair
When saved policy evidence is absent, a uniquely matched structure at the renewal
boundary may supply a labelled display-only grace period, not today's structure.

**Why:** The user approved retaining expired upfront terms during grace without
inventing missing commencement dates, paid amounts or purchase snapshots.

**How to apply:** Prefer saved policy, preserve original year and paid-through
date, label grace and separate renewal charges. Do not use display fallback to
alter billing, access enforcement or historical records; exclude paused,
cancelled and superseded terms.