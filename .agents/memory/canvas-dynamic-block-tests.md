---
name: Canvas dynamic-block tests
description: How to exercise dynamic Canvas renderers in the Node/tsx test environment without circular imports or Vite-only page failures.
---

Test dynamic Canvas blocks through the registry entry point, not by importing the dynamic-block module directly. For renderers that lazy-load full pages, provide injectable test components at that boundary rather than waiting for the real lazy import.

**Why:** The registry and dynamic-block modules intentionally reference each other; using the dynamic side as the Node ESM entry can expose an initialization-cycle error that the app bundler does not. Letting a React test resolve a full lazy page can then load modules that depend on Vite's `import.meta.env`, which is unavailable under the project's Node/tsx test runner.

**How to apply:** Use a JSDOM registry-backed renderer test for real block registration and Canvas context behavior. Inject lightweight components only for the lazy page boundary, while separately testing identifier/prop selection and preserving the production defaults.