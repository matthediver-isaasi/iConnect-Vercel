---
name: PL/pgSQL output-column qualification
description: RETURNS TABLE output names can make otherwise valid claim queries fail only when invoked.
---

Qualify column references that share names with `RETURNS TABLE` outputs, including DML `RETURNING` and the final CTE `SELECT`.

**Why:** A recovery function installed successfully but every invocation failed with SQLSTATE `42702`: its unqualified submission ID was also a PL/pgSQL output variable. Mocked application tests and successful migration installation did not exercise that name resolution.

**How to apply:** Use explicit table/CTE aliases rather than changing `plpgsql.variable_conflict`. Invoke replacement claim functions against isolated PostgreSQL fixtures. A destination probe inside an enforced read-only transaction can confirm planning reaches the write guard without claiming real work.