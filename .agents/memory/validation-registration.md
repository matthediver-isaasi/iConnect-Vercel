---
name: Validation registration side effects
description: Registering validation commands may also append them to the default Project workflow.
---

After registering a new validation command, check whether the platform also
added it as a child of the default Project/Run workflow.

**Why:** Registration unexpectedly appended standalone regression suites to Run,
violating the application's startup safety boundary despite their validation
metadata being correct.

**How to apply:** Keep the standalone validation workflow but remove unintended
Project membership using the schema-validated `.replit` replacement mechanism.
Do not weaken the startup safety test or remove validation merely to pass it.