---
name: Stale form field type metadata
description: Legacy field options can survive type changes and must not redefine scalar validation.
---

Treat the current field type as the authority for interpreting type-specific metadata; the presence of an options array does not prove a field is a choice control.

**Why:** A live Equipment date field retained an old YesNo options array. Its populated decommissioning year was displayed correctly but rejected by shared selection validation.

**How to apply:** Gate choice allowlists by actual choice types on client and server. Preserve date/type validation and genuine selection rejection. Do not rewrite reviewed form configurations merely to compensate for a validator misinterpreting inert metadata.

For direct form-type adaptations, run the destination field's configuration validators as well as affiliation validation.

**Why:** A join-to-renewal conversion passed affiliation checks while retaining Payment-only Stripe address metadata. The live form rendered, but its next ordinary builder save was rejected.

**How to apply:** Remove unsupported type-specific properties when converting fields, preserve unrelated mappings, and verify the resulting configuration against normal save validators. Passing affiliation validation alone is not proof the form remains editable.