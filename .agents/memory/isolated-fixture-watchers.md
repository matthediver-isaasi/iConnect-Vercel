---
name: Isolated fixture watchers
description: Prevent standalone Vite test fixtures exhausting the workspace watch limit.
---
Disable file watching on static verification-only Vite fixtures, or explicitly narrow their watch scope.

**Why:** A second Vite server rooted at this large workspace watched unrelated tool-cache files and failed with ENOSPC despite the application server working normally.

**How to apply:** Use `server.watch: null` for screenshot fixtures that do not need live reload. Do not disable the application's normal development watcher.
