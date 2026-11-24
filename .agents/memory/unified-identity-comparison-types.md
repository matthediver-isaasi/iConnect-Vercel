---
name: Unified identity comparison types
description: Production unified identity keys are strings even where Sales principal references are UUIDs.
---

Do not assume unified identity IDs share the UUID type used by Sales principal
references. Compare compatible representations without casting arbitrary external
identity strings to UUID.

**Why:** An opportunity-owner guard passed isolated tests whose identity fixture
used UUIDs, then failed in production with SQLSTATE 42883 because the actual
identity key was varchar. Source-shape verification alone did not expose this.

**How to apply:** Inspect real column types before identity-related migrations.
Exercise the complete trigger path against varchar identity keys, including
non-UUID values, and preserve tenant/active-role checks. Test owner and
collaborator paths, not just function installation.
