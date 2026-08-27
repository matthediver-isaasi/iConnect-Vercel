---
name: Form relationship value security
description: Security boundaries for form fields that store IDs selected from dependent relationship options.
---

Dependent relationship option APIs are only a presentation aid, not an authorization boundary. Every form write path—including alternate public surfaces, manual entry, and later review amendments—must server-side revalidate the selected record against the saved field, effective parent value, active relationship edge, lifecycle, visibility, and tenant.

**Why:** A correctly constrained options endpoint still permits forged UUIDs when even one submission or amendment path writes browser values directly. Review amendments need validation against the merged effective values, because unchanged parent fields may live only in the original submission.

**How to apply:** Route all form surfaces through validated server handlers. For human-readable output, never expose a generic tenant-wide ID-to-label endpoint; derive allowed IDs from persisted submissions the caller may access, then intersect requested IDs and resolve active labels.