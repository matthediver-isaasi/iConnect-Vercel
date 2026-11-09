---
name: Absent typed-row audit JSON
description: PostgreSQL typed-row absence when reconciling before-data audit evidence.
---
Audit verification must distinguish a missing joined row from a typed PL/pgSQL row populated by a SELECT INTO that found nothing.

**Why:** The former can serialize as JSON null while the latter serializes as an object with every attribute null. Treating these representations as identical caused a guarded stock operation to roll back despite correct audit output.

**How to apply:** Derive the exact expected absent-row representation from the inspected RPC and live composite shape. Accept the all-null object only for a proven absent pre-update row; retain exact comparisons for existing rows.
