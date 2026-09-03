---
name: Contextual Custom Object creation
description: Durable rules for metadata-driven record creation from relationship cards.
---

Create a Custom Object record and all initial relationship edges in one database transaction. The client must never create the record first and attach edges afterward.

**Why:** Required relationships, endpoint eligibility, and cardinality can change concurrently. A multi-request flow can leave an orphan record or partial links, while one RPC lets existing database guards and audit triggers commit or roll back together.

**How to apply:** Treat the new record’s relationship side as the orientation key. Required relationship semantics apply when the new record is the source; the fixed originating edge is authorized from the opposite existing-card side. Load all metadata pages before presenting the form, and keep self-relationship selectors keyed by both definition and side.