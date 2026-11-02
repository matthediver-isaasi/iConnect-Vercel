---
name: Vite browser fixture imports
description: Direct browser fixtures must use the running Vite dependency URLs and CommonJS interop.
---
Browser-injected fixtures must reuse the dependency URLs from the running Vite-transformed component, rather than assuming `/node_modules/.vite/...` is served at the client root. Initialise React Refresh before dynamically importing JSX. Direct dynamic imports of prebundled CommonJS dependencies may expose their API under `default`.

**Why:** A fixture can render nothing even when the actual application is healthy: Vite normally supplies both path rewriting and CommonJS interop, which raw injected scripts bypass.

**How to apply:** Reuse the established browser fixture setup, resolve dependencies from transformed source, and capture page errors before waiting for UI controls. Use the system Chromium executable when the downloaded Playwright binary lacks Nix shared libraries.
