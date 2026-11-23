---
name: Merge and migration authority
description: Keep automatic merge setup separate from approved live database migrations.
---

Routine merge setup must not replay historical live database migrations.

**Why:** An unrelated task merge failed when automatic setup retried an old migration using rejected database credentials. A historical approval and hash do not establish the current installation state or authorise replay.

**How to apply:** Keep dependency setup independent of live database access. Verify installation state and obtain explicit approval for pending migrations through their guarded destination-specific runners; do not suppress migration errors or fall back to another database.
