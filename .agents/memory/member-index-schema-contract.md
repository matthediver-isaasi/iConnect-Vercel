---
name: Member index schema compatibility
description: Legacy chunk uniqueness must not be restored over generation-based publication.
---
Do not repair a legacy member-content ON CONFLICT failure by restoring three-column uniqueness when the destination has generation-based chunk publication.

**Why:** A generation-aware service stages a replacement alongside the old generation before activation. Legacy uniqueness forbids that coexistence. A legacy writer also omits required generation metadata and activation, so recreating its index merely changes the failure or damages publication.

**How to apply:** Inspect the live constraints, required/defaulted columns, and activation functions before changing indexes. Reconcile the deployed writer with the generation contract; do not replay the original migration or add a default generation as a compatibility shortcut.

Operational adapters must be verified with the real driver's value types and
read-only live-schema probes, not solely permissive mocks or conventional column
names.

**Why:** Mocked repair tests passed while the operational boundary still disagreed
with production about JSON arrays, bigint representation and optional columns.
These failures did not require another schema change.

**How to apply:** Exercise the driver-to-RPC boundary in temporary PostgreSQL and
probe the actual composite/vector format without writes before the bounded live
sample. Keep operational reports separate from this durable lesson.

Validate production publication through Supabase REST as well as direct SQL.

**Why:** The REST session enforces safe-update rules that a direct PostgreSQL
connection does not, even inside a SECURITY DEFINER function and on temporary
staging tables. A successful direct-SQL sample therefore does not prove the
deployed application's RPC transport will succeed.

**How to apply:** Keep meaningful predicates on staging updates, and include a
bounded service-role REST save/repeat check before declaring writer recovery.