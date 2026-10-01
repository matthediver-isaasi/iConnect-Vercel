---
name: Private uploads and checkpoints
description: Git ignore rules do not remove uploads already captured in shared automatic checkpoints.
---

For private import inputs, check both the Git index and inherited history before claiming a file is excluded from the repository.

**Why:** An uploaded member workbook was initially untracked, but an automatic checkpoint committed it to the shared main branch while validation work was underway. Adding an ignore rule afterward did not untrack it.

**How to apply:** Add narrowly scoped ignore rules early, remove private inputs from the index while retaining local bytes, and verify the source hash. If a shared base already contains the input, disclose the historical caveat; do not rewrite shared refs or claim historical purging without separate authorization and an assessment of affected branches/caches.

Completion itself can capture an unrelated untracked private upload before its code review runs. Check untracked uploads before completion, not just before manual commits.

**Why:** A presentation-only change acquired an unrelated member spreadsheet during completion despite no intentional staging of that file.

**How to apply:** Ignore private inputs before invoking completion. Amending the task branch removes an accidental inclusion from that branch's history, but does not prove backup refs, checkpoints, or other retained copies are purged.

Completion checkpoints can include pre-existing edits; completion can also rebase onto newer shared commits before validation.

**Why:** Tests passing on a locally isolated tree do not prove the subsequently rebased tree passes, and a diff against an old base can misattribute upstream work.

**How to apply:** Record the starting dirty paths. Preserve unrelated work before authorized separation. After completion reports unexpected changes or failures, inspect the reflog and current upstream diff before removing anything; never revert newly merged shared work merely to reproduce an older isolated test result.

Treat monitoring screenshots as potentially credential-bearing uploads before
completion, even during read-only investigations.

**Why:** A heartbeat reporting URL is a bearer capability to submit success or
failure, and a screenshot can expose it without any secret appearing in text.
Removing the image from the current tree does not revoke the capability or purge
older checkpoints.

**How to apply:** Exclude the original sensitive upload from commits. If task
separation is authorized, preserve unrelated work in a clean-parent branch that
omits the sensitive upload, not a branch of the contaminated commit. Disclose
retained-history limits and obtain separate authorization for endpoint rotation.