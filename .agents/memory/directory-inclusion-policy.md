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
