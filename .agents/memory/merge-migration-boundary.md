---
name: Merge and migration authority
description: Keep automatic merge setup separate from approved live database migrations.
---

Routine merge setup must not replay historical live database migrations.

**Why:** An unrelated task merge failed when automatic setup retried an old migration using rejected database credentials. A historical approval and hash do not establish the current installation state or authorise replay.

**How to apply:** Keep dependency setup independent of live database access. Verify installation state and obtain explicit approval for pending migrations through their guarded destination-specific runners; do not suppress migration errors or fall back to another database.

Managed migration history can use deployment-generated versions rather than
source filename versions. A missing original version is not evidence that its
schema is missing.

**Why:** Installed project mention and image prerequisites existed with the
correct contracts despite having no history entries under their source versions.
Replaying them would have attempted to recreate live objects.

**How to apply:** Inspect actual signatures, definitions, column types,
constraints and grants, then reconcile them with recorded rollout evidence.
Never replay a prerequisite solely because a filename-version lookup is empty.
