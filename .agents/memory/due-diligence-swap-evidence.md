---
name: Due Diligence swap evidence
description: Historical review snapshots may differ from persisted applicant references.
---

Original and reviewed Due Diligence snapshots can both contain the same obsolete
organisation reference even when the raw submission answer and persisted
applicant linkage agree on a current reference.

**Why:** A read-only GSF incident investigation reproduced this exact divergence;
it was not evidence of an ownership or reviewer-permission failure.

**How to apply:** Diagnose all answer layers and persisted linkage separately.
Never infer an applicant by correcting a malformed identifier, matching a name,
or using the reviewer’s organisation. Any reference recovery must retain target
eligibility validation and must not imply organisation mutation authority.
