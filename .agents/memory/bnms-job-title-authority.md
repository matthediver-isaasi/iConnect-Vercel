---
name: BNMS imported Job Title authority
description: Approved Occupation mapping and protection of imported Notes and subsequent edits.
---

The owner approved using the original BNMS import **Occupation** as the member's core **Job Title** after confirming that the example source has no separate Job Title column. Source **Title** is a salutation, not a job title.

**Why:** Some historical imports put Notes text into Job Title. The owner wants the original Notes preserved as member notes, with Occupation used for the title instead.

**How to apply:** Require tenant-scoped, unambiguous email and legacy-member identity matches against pinned import sources. Preserve the old Notes text verbatim with automated provenance. Conflicting occupations, changed live Occupation values and differently edited titles must not be overwritten. Blank titles alone are not evidence that a previous cleanup cleared them, so this approval must not silently become a blanket blank-field backfill. Historical importers must not be rerun to perform this repair.
