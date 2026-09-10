---
name: Parallel browser-test output
description: Isolate artifacts when separate Playwright commands run concurrently.
---

Give independent, concurrent Playwright invocations distinct output directories, including live-data harnesses and fixture smoke tests.

**Why:** Playwright cleans its output directory when a run starts. Two processes using the default directory can pass their browser assertions but fail during context teardown because the other process removed an active trace file.

**How to apply:** Use distinct `--output` paths or per-config `outputDir` values for concurrent commands. Keep live-data screenshots and authentication state outside tracked project files.