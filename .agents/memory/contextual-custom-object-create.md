---
name: Contextual Custom Object creation
description: Durable rules for metadata-driven record creation from relationship cards.
---

Create a Custom Object record and all initial relationship edges in one database transaction. The client must never create the record first and attach edges afterward.

**Why:** Required relationships, endpoint eligibility, and cardinality can change concurrently. A multi-request flow can leave an orphan record or partial links, while one RPC lets existing database guards and audit triggers commit or roll back together.

**How to apply:** Treat the new record’s relationship side as the orientation key, including selector labels. Required semantics apply when the new record is the source; authorize the fixed edge from the opposite card side. Keep optional selectors empty-safe and cardinality-aware. Load all metadata pages, key self-relationships by definition and side, and fail with an operational error if the service-role-only atomic RPC is absent—never fall back to sequential writes.