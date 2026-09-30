---
name: Resource import audit evidence
description: Separate current absence from execution failure and preserve terminal identity evidence.
---

An import audit must resolve a journal's successfully executed destination ID
against the current snapshot before falling back to URL or title candidates.
Later execution supersedes an earlier proposal hold; retain both events rather
than treating a historical hold flag as the final outcome.

**Why:** Resources can keep their IDs while their URLs change. URL-only matching
can falsely report them absent or ambiguous, and merged hold/execution flags can
misrepresent later successful imports as still blocked.

**How to apply:** Report current identity presence, metadata differences and
historical execution outcome separately. Deliberately held absent rows need
decisions, but do not establish execution failures. Missing journals do not
prove an import never ran.