---
name: Validation thread pressure
description: Distinguishing concurrent runner resource exhaustion from product regressions.
---

When many regression suites run together, Node workers can exit before tests start with `pthread_create: Resource temporarily unavailable`. Rerun the affected commands sequentially before treating these exits as application failures.

**Why:** Concurrent completion validation exhausted workspace threads; all four affected commands passed unchanged when run sequentially.

**How to apply:** Inspect failing logs for worker-startup failures, keep real assertion failures distinct, and preserve configured checks rather than weakening their assertions.
