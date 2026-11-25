---
name: Campaign preparation journal errors
description: The journalled db used during campaign audience preparation throws provider errors instead of returning { error }.
---
Inside campaign audience preparation, the db handed to resolvers is a journalling proxy that throws `result.error` rather than returning it. Code that checks `answer.error` (e.g. to tolerate a not-yet-installed RPC via PGRST202/42883) never sees it; the error aborts preparation.
**Why:** the member lifecycle migrations were not installed on DEST (2026-11-25), and the intended "skip if missing" check was dead, so every campaign failed with a schema-cache error.
**How to apply:** tolerate optional RPCs with try/catch on the error code, and test through the real journal, not a fake that returns { error }.
