---
name: Unsaved editor authority
description: Keep authored-state navigation checks independent of delayed rendering and save-time route changes.
---

Navigation protection must observe authored edits immediately, even when generating
their rendered output is delayed. Compare a confirmed saved snapshot, not a
post-request read of whatever happens to be on screen.

**Why:** A builder's HTML debounce creates a brief interval where its visible
design is newer than its parent form. Saving or navigating during that interval
can otherwise silently lose the latest edit. Generated footer changes are not
authored changes.

**How to apply:** Publish authored state synchronously while retaining delayed
rendering work. Keep route replacement after creation separate from saving so a
pending destination is not replaced by an intermediate editor redirect. Preserve
edits made during requests against the submitted baseline, rather than treating
the whole current form as saved.
