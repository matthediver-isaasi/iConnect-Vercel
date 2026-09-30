---
name: Vite lazy route declaration ordering
description: Development transform can expose a lazy import TDZ even when production builds pass.
---

Keep React imports before module-level lazy route declarations.

**Why:** A production build accepted interspersed lazy declarations above the React import, but the development runtime reported “Cannot access lazy before initialization.” Build success alone did not catch the transformed-module ordering issue.

**How to apply:** Place imports used by module-scope expressions first, and verify route changes in the running development app as well as the production build.