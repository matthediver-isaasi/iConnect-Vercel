---
name: Verification boundaries
description: Testing modes, route contracts, parallel test artifacts, and stable browser geometry assertions.
---

- [Fixture route contracts](browser-fixture-route-contracts.md) — reject unexpected mutation endpoints; fabricated commit markers can hide a missing transaction.
- [Parallel test output](parallel-browser-test-output.md) — concurrent Playwright runs need separate output directories to protect active traces.
- [Geometry assertions](browser-geometry-assertions.md) — finish dialog entrance animations before measuring fixed-header geometry.
- [Mutation test cleanup](react-query-test-exit.md) — query-only cleanup leaves mutation GC timers keeping otherwise-passing mounted tests alive.
- [Testing mode boundaries](testing-mode-boundaries.md) — retain deliberate production reads; fixture isolation is separate, and validation registration can reattach tests to Run.