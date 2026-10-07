---
name: Git authentication authority
description: Distinguish connection status from actual Git push authentication.
---

Do not treat a healthy GitHub integration status or successful public repository read as proof that Shell push authentication works.

**Why:** This workspace reported an active connection while push authentication failed even after reconnecting. The user confirmed that interactive token authentication bypassing automatic credential sources worked.

**How to apply:** Verify write authentication with a push dry-run. Distinguish a working per-command bypass from a permanent connection repair; never store credentials in project files or memory.
