---
name: Private uploads and checkpoints
description: Git ignore rules do not remove uploads already captured in shared automatic checkpoints.
---

For private import inputs, check both the Git index and inherited history before claiming a file is excluded from the repository.

**Why:** An uploaded member workbook was initially untracked, but an automatic checkpoint committed it to the shared main branch while validation work was underway. Adding an ignore rule afterward did not untrack it.

**How to apply:** Add narrowly scoped ignore rules early, remove private inputs from the index while retaining local bytes, and verify the source hash. If a shared base already contains the input, disclose the historical caveat; do not rewrite shared refs or claim historical purging without separate authorization and an assessment of affected branches/caches.

Completion checkpoints can include pre-existing edits; completion can also rebase onto newer shared commits before validation.

**Why:** Tests passing on a locally isolated tree do not prove the subsequently rebased tree passes, and a diff against an old base can misattribute upstream work.

**How to apply:** Record the starting dirty paths. Preserve unrelated work before authorized separation. After completion reports unexpected changes or failures, inspect the reflog and current upstream diff before removing anything; never revert newly merged shared work merely to reproduce an older isolated test result.