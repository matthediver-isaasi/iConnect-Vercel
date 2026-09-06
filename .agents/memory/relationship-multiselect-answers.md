---
name: Relationship multi-select answers
description: Rules for arrays that may combine real relationship record IDs with the configured Other sentinel.
---

Treat a multi-select relationship answer as a sequence of independently meaningful members. A valid answer may contain multiple real record IDs and, when configured, the Other sentinel with its companion text.

**Why:** Whole-value shortcuts lose information: treating any array containing Other as only an Other answer drops real records, while resolving every member as a record leaks or rejects the sentinel. Cleanup can likewise corrupt an answer if it clears the entire array when only one member becomes stale.

**How to apply:** Reconcile and validate each real ID against authoritative options, handle the Other sentinel separately, preserve ordering while removing invalid members, and format the final mixed answer only after resolving both kinds. Keep single-select and field types with exclusive Other behavior unchanged. Do not allow a multi-select relationship field to act as another relationship field's parent because dependent option loading requires one canonical parent record.