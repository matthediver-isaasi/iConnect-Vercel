---
name: Organisation reference vs mutation authorization
description: Security boundary for reusing organisations selected by public forms without granting edit authority.
---

A tenant-validated organisation selected through an authoritative persisted form answer may be reused as a relationship reference. Reference use alone must not require ownership, but every core-field update, custom-field upsert, or clear on an existing organisation must require administrator access or verified ownership.

**Why:** Legacy linkage fields and generic pipeline checkpoints can contain either newly created IDs or referenced existing IDs. Treating either as proof of creation can turn a harmless public selection into mutation authority during retries, especially if an idempotency lookup fails open.

**How to apply:** Place authorization immediately before actual existing-organisation write boundaries. Exempt only records with immutable, explicit creation provenance; absent that provenance, fail closed. Never infer creation from a Not-listed answer, a checkpoint, or an overloaded `created_*` linkage field.

Dropdown eligibility restricts selections of existing organisations; it is not a prerequisite for an organisation created from an enabled Not-listed choice to complete Related Records processing. Keep that exception tied to the exact winning identity-source field, not every field containing the same name.

**Why:** Respondent-controlled names can collide across fields, and later mappings can overwrite the name with identical text. Name equality proves neither which field created the record nor which field may bypass the second eligibility check.

**How to apply:** Carry current-run creation provenance separately from browser answers, clear it when another mapping wins, and retain tenant, Department endpoint, definition, and active-edge validation. Resolve the created ID only at the reference boundary: visibility and conditional rules must still see the respondent's original Not-listed choice, or hidden stale answers can become active.