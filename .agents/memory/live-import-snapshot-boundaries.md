---
name: Live import snapshot boundaries
description: How to distinguish controlled-import invariants from concurrent production activity.
---

Use exact cohort and pre-existing record checks alongside broad snapshots; do not
claim a whole tenant stayed unchanged when other administrators or deployments
were active.

**Why:** A registration import overlapped with a survey-schema migration and
campaign activity. Broad table hashes changed even while every controlled booking
and prohibited cohort artifact passed verification. Ignoring all drift would hide
real changes; rejecting all drift would incorrectly imply the import failed.

**How to apply:** Preserve the original baseline. Compare every historical field
and the complete latest approved pre-write record. Allow only explicitly reviewed
additive schema fields, never arbitrary missing/new columns. Disclose unrelated
snapshot drift separately, and never let its acknowledgment waive award, payment,
attendance, identity, or cohort-side-effect checks.