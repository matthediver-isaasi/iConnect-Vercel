---
name: Isolated fixture watchers
description: Prevent standalone Vite test fixtures exhausting the workspace watch limit.
---
Disable file watching on static verification-only Vite fixtures, or explicitly narrow their watch scope.

**Why:** A second Vite server rooted at this large workspace watched unrelated tool-cache files and failed with ENOSPC despite the application server working normally.

**How to apply:** Use `server.watch: null` for screenshot fixtures that do not need live reload. Do not disable the application's normal development watcher.

Give standalone fixture servers their own Vite dependency cache directory.

**Why:** A fixture rooted outside the application's client root can share the workspace dependency cache and invalidate the running application's optimized dependencies, causing blank preview pages with “Outdated Optimize Dep” responses.

**How to apply:** Set a fixture-specific `cacheDir` under `/tmp`, separate from the application cache, when running isolated Vite browser checks alongside the normal development server.
