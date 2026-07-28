---
name: Merge verifier flags "=======" comment separators
description: continueMergeResolution's marker check substring-matches 7+ '='; decorative comment rulers in a conflicted file cause false "markers remain".
---

The task-merge verifier behind `continueMergeResolution` rejects a conflicted file if any line contains a run of 7+ `=` characters — even pre-existing decorative comment separators like `// =====...` that exist identically on both sides.

**Why:** hit on canvasDesign.js — file was fully resolved (no real markers) but the verifier kept reporting "Conflict markers remain".

**How to apply:** if `continueMergeResolution` claims markers remain but `grep '<<<<<<<\|^=======$\|>>>>>>>'` finds nothing, look for long `=` runs in comments and rewrite them as `-` rulers, then retry.
