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

Always assign a string filename before compiling an in-memory CommonJS test module.

Avoid extensionless imports when colocated module basenames differ only by case, even if their extensions differ.

**Why:** esbuild resolved a lowercase helper import to a same-named uppercase JSX component on this Linux workspace, producing a missing-export build failure despite passing direct Node helper tests.

**How to apply:** Give related helpers and components distinct basenames and compile their importing page, not just standalone helper tests.

**Why:** On Node 24, passing an undefined filename to `Module._compile` can
abort the entire process with a native assertion rather than report a JavaScript
test failure.

**How to apply:** Set the module's filename and resolver paths before compiling
an esbuild fixture; do not diagnose this native assertion as application code.

Node's test CLI interprets positional file paths as globs, including square
brackets in dynamic route directories. Shell quoting does not make those
brackets literal to Node.

**Why:** A successful test command silently omitted the bracket-directory API
tests; its reported count exposed that only the other files had run.

**How to apply:** Use a bounded wildcard directory pattern or escape brackets
for Node itself, and check that the reported test count includes every suite.
