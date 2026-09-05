---
name: Relationship edge metadata enforcement
description: Why relationship-level field defaults and constraints must cover every generic edge creation path.
---

Generic relationship-edge field defaults and required/type constraints must be enforced at the database boundary as well as in the interactive relationship service.

**Why:** Generic edges are also created by atomic record creation and trusted form-processing paths. Service-only normalization creates inconsistent edges when those paths insert directly.

**How to apply:** When adding relationship-level metadata semantics, keep friendly service validation for API callers and mirror invariant/default enforcement in the shared database insert/update path.