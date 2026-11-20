---
name: Node test runtime boundaries
description: Native navigator globals and mixed CommonJS/ESM React Query test contexts.
---

Legacy jsdom tests that assign `globalThis.navigator` need Node's
`--no-experimental-global-navigator` flag on the patched Node 24 runtime.
Do not interpret their getter-only assignment failure as a product regression.

**Why:** Node exposes a native getter-only navigator; these tests predate it.

**How to apply:** Pass the flag when running affected existing tests rather
than weakening application behaviour to accommodate the harness.

When a test loads an esbuild CommonJS bundle with external packages, obtain
React Query's provider from the same CommonJS module resolver.

**Why:** Mixing an ESM-imported provider with CommonJS hooks can create separate
contexts and falsely report that no QueryClient was set.

**How to apply:** Keep provider and hooks on the same package entrypoint;
this applies to bundled SSR or mounted test harnesses, not production imports.
