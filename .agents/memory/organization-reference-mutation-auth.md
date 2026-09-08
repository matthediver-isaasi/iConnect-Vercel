---
name: Organisation reference vs mutation authorization
description: Security boundary for reusing organisations selected by public forms without granting edit authority.
---

A tenant-validated organisation selected through an authoritative persisted form answer may be reused as a relationship reference. Reference use alone must not require ownership, but every core-field update, custom-field upsert, or clear on an existing organisation must require administrator access or verified ownership.

**Why:** Legacy linkage fields and generic pipeline checkpoints can contain either newly created IDs or referenced existing IDs. Treating either as proof of creation can turn a harmless public selection into mutation authority during retries, especially if an idempotency lookup fails open.

**How to apply:** Place authorization immediately before actual existing-organisation write boundaries. Exempt only records with immutable, explicit creation provenance; absent that provenance, fail closed. Never infer creation from a Not-listed answer, a checkpoint, or an overloaded `created_*` linkage field.