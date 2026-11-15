---
name: Project list reorder locking
description: Why reorder serialization must cover legacy list creation and archive/delete writers.
---
Do not replace list reorder's table lock with only a board advisory lock unless every list-set writer also acquires that lock.

**Why:** Existing create/archive/delete paths write directly, so a board-only lock in reorder cannot protect its complete-active-set validation. The short table lock trades cross-board write concurrency for atomic compatibility without changing the wider project schema.

**How to apply:** If board traffic warrants finer locking, migrate all list-set mutation paths together and test concurrent creation, archiving and deletion, not just competing reorder calls.
