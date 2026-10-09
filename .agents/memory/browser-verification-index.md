---
name: Verification boundaries
description: Testing modes, route contracts, parallel test artifacts, and stable browser geometry assertions.
---

- [Fixture route contracts](browser-fixture-route-contracts.md) — reject unexpected mutation endpoints; fabricated commit markers can hide a missing transaction.
- [Parallel test output](parallel-browser-test-output.md) — concurrent Playwright runs need separate output directories to protect active traces.
- [Geometry assertions](browser-geometry-assertions.md) — finish dialog entrance animations before measuring fixed-header geometry.
- [Isolated fixture watchers](isolated-fixture-watchers.md) — static verification fixtures must not exhaust filesystem watchers by scanning workspace caches.
- [Mutation test cleanup](react-query-test-exit.md) — query-only cleanup leaves mutation GC timers keeping otherwise-passing mounted tests alive.
- [Testing mode boundaries](testing-mode-boundaries.md) — retain deliberate production reads; fixture isolation is separate, and validation registration can reattach tests to Run.
- [Login landing verification](login-landing-verification.md) — separate tenant demo policy from ordinary and contextual login fixtures.
- [PDF browser verification](pdf-browser-verification.md) — fixture layout evidence is separate from unshimmed PDF.js compatibility.
- [Consent report verification](consent-report-verification.md) — assert individual matrix cells, not row-wide text.
- [Excel report validation](excel-report-validation.md) — valid ZIP/XML does not establish Excel compatibility.
- [Live import snapshot boundaries](live-import-snapshot-boundaries.md) — separate cohort invariants from concurrent production activity.