---
name: Bulk member deletion FK indexes
description: Performance safety for deleting many Members referenced by large restrictive child tables.
---

Bulk Member deletion must account for restrictive foreign-key checks on child tables. A missing leading index on the child reference can make PostgreSQL scan the full child table once per deleted Member.

**Why:** Large email-history tables without member-reference indexes turned a few-thousand-row cleanup into a multi-minute transaction; transaction-contained helper indexes reduced it to seconds.

**How to apply:** Prefer permanent leading indexes on large child FK columns. For a one-off rollback-first cleanup, create only missing helper indexes inside the transaction, retain them through deletion and postconditions, then drop them before the final COMMIT/ROLLBACK switch.