---
name: Organisation name recovery
description: Evidence boundaries when recovering blank organisation names.
---

Recover organisation names by exact tenant-scoped record ID, not fuzzy name matching.
Treat a conflict between a hidden form-mapping name and the submitter's explicit
“Not listed” organisation text as a review decision, not interchangeable evidence.

**Why:** A Student Join record carried a placeholder in its hidden organisation-name
field while separate submissions consistently named a real institution in the
not-listed answer. Blindly copying the hidden field would restore a placeholder.

**How to apply:** Compare original imports and submitted evidence, preserve all
other fields and relationships, and ask before resolving conflicting name authority.
An organisation's updated timestamp alone cannot establish when its name was cleared.
