---
name: Entity-pipeline mapping ownership
description: How fixed member and organisation pipelines govern mapping destination metadata and side effects.
---

Treat the enclosing entity pipeline as authoritative for mapping destination entity. Normalize missing or stale mapping metadata when configurations are loaded and edited, and require destination-sensitive side effects to match that pipeline entity.

**Why:** Saved mapping metadata can be missing or stale. Trusting it either shows the wrong destination in the editor or lets a mapping write to the wrong record type; ignoring it everywhere also removes a useful fail-closed check at side-effect boundaries.

**How to apply:** For any new entity-specific mapping destination, derive editor availability and labels from the fixed pipeline, serialize that entity into mappings, and have processors accept only mappings whose saved entity matches the pipeline currently being processed.