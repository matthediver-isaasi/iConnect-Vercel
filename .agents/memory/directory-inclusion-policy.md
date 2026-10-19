---
name: Directory inclusion configuration
description: Tenant-independent inclusion rules and the GFI configuration boundary.
---

Do not change GFI's live Partner Directory or guess its application-status
values. GFI must supply the desired values before its configuration is edited.

**Why:** The user requested reusable tenant-independent rules, not a GFI-specific
policy or an automatic live configuration change.

**How to apply:** Use synthetic statuses for fixtures. Keep visitor search
settings separate from inclusion conditions, including inherited null settings.

Dynamic-directory carousels use the selected directory's inclusion rules, not
the primary Organisation Directory's status/type selectors.

**Why:** GFI's primary directory selects Universities, while its Partner
Directory selects Partners. Intersecting these independent populations silently
hid all 13 partners without changing their source records.

**How to apply:** Retain explicit exclusions, field privacy and public-carousel
consent. Do not relax the primary directory's own status/type eligibility or
alter saved tenant settings to compensate for a consumer using the wrong rules.
