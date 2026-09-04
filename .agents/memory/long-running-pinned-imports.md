---
name: Long-running pinned imports
description: Operational rule for imports whose safe sequential writes can exceed an interactive command timeout.
---

Run large pinned imports so an external interactive-shell timeout cannot be mistaken for transaction-level rollback. If interrupted, first run the non-mutating planner to measure the partial state, then resume only when every operation is idempotent and finish with a zero-write replay.

**Why:** Compensation journals exist only in the running process. An external process kill can leave a valid partial prefix even when application-level compensation is correct.

**How to apply:** Prefer a background execution path for large sequential imports. After any interruption, never assume either full success or full rollback; re-plan, resume idempotently, and verify the complete cohort and preservation boundaries.