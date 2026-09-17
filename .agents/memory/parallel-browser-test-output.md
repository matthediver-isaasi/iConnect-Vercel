---
name: Parallel browser-test output
description: Isolate artifacts when separate Playwright commands run concurrently.
---

Give independent, concurrent Playwright invocations distinct output directories, including live-data harnesses and fixture smoke tests.

**Why:** Playwright cleans its output directory when a run starts. Two processes using the default directory can pass their browser assertions but fail during context teardown because the other process removed an active trace file.

**How to apply:** Use distinct `--output` paths or per-config `outputDir` values for concurrent commands. Keep live-data screenshots and authentication state outside tracked project files.

Browser fixtures must isolate direct Supabase REST and Realtime traffic as well as `/api/` routes.

**Why:** Optional shell widgets can contact real services with fixture tenant IDs and raise unrelated runtime overlays that block report interactions.

**How to apply:** Intercept those transports in fixture-based browser suites rather than dismissing error overlays. The workspace system Chromium can predate `URL.parse`, which newer Playwright websocket interception uses; use a compatible browser or a test-only standards-equivalent shim.

Use the workspace system Chromium when Playwright's bundled headless shell cannot load its native libraries.

**Why:** In this Nix workspace the bundled shell can fail before launch with a missing `libglib-2.0.so.0`, while the installed system Chromium runs the same tests successfully.

**How to apply:** Point a test configuration's executable-path override at the installed `chromium` binary instead of changing application code or repeatedly reinstalling the browser.