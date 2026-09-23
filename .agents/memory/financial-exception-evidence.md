---
name: Financial exception evidence
description: Preserve full provider evidence behind exact financial-exception approvals.
---

Preserve a private immutable full provider response alongside the canonical digest whenever approving or renewing a financial exception.

**Why:** A digest plus amount summary cannot explain a later mismatch. Provider timestamps, optional fields and array order can change a digest without proving a business change; a mutable checkpoint may overwrite the only approved baseline.

**How to apply:** Use the same canonical hashing function as the release guard, retain both reviewed and observed snapshots privately, and compare actual fields before describing a mismatch as a changed invoice. Never weaken the exact approval guard or assume unchanged amounts prove the whole evidence is unchanged.