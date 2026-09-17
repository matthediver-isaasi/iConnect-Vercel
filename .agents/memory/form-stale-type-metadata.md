---
name: Stale form field type metadata
description: Legacy field options can survive type changes and must not redefine scalar validation.
---

Treat the current field type as the authority for interpreting type-specific metadata; the presence of an options array does not prove a field is a choice control.

**Why:** A live Equipment date field retained an old YesNo options array. Its populated decommissioning year was displayed correctly but rejected by shared selection validation.

**How to apply:** Gate choice allowlists by actual choice types on client and server. Preserve date/type validation and genuine selection rejection. Do not rewrite reviewed form configurations merely to compensate for a validator misinterpreting inert metadata.