---
name: Training agenda timezone policy
description: Explicit DST ambiguity policy for agenda-derived event bounds.
---
Agenda wall clocks belong to the event timezone, not the browser timezone. Reject DST gaps and repeated minutes; do not guess an occurrence.

**Why:** Agenda rows have no occurrence/offset field, so accepting an ambiguous minute cannot preserve organiser intent on reopening. The authorized correction changes only overall bounds, never agenda clocks or provider schedules.

**How to apply:** Keep preview and save derivation identical. Supporting repeated minutes later requires an explicit, persisted occurrence choice rather than changing the default conversion.
