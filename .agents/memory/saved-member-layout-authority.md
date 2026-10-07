---
name: Saved member layout authority
description: Default Direct Debit fields versus explicitly configured member layouts.
---

Treat existing saved member layouts as authoritative, including missing Direct Debit cards or individual mandate fields. Keep these fields in the default for unconfigured layouts only.

**Why:** The user approved this distinction after the automatic field-insertion migration recreated a deliberately removed card. An older saved layout without the fields cannot reliably be distinguished from intentional removal.

**How to apply:** Metadata migrations may normalize existing placements, but must not add back omitted cards or fields. Layout choices affect display only, never mandate or payment state.
