---
name: PostgreSQL safety topics
description: Function permissions, pooled locks, nullable JSON and legacy schema compatibility.
---
- [SECURITY DEFINER RPC grants](security-definer-rpc-grants.md) — new functions are PUBLIC-executable by default; server-only functions need explicit grants and SQL validation.
- [Supabase default table grants](supabase-default-table-grants.md) — narrow column grants do not remove default service-role table-wide permissions.
- [PL/pgSQL output names](plpgsql-output-column-qualification.md) — qualify output-name collisions and test execution, not installation alone.
- [Transaction-pool advisory locks](transaction-pool-advisory-locks.md) — explicit transactions and transaction-scoped locks prevent pooled-session lock leakage.
- [Nullable JSONB migration merges](nullable-jsonb-migration-merges.md) — coalesce nullable JSON before idempotent merges.
- [Legacy transition-row types](legacy-transition-row-types.md) — dropped attributes can break whole transition-row composites only on the real long-lived schema.
- [RPC fixture schema parity](rpc-fixture-schema-parity.md) — verify deployed key types and ownership columns; similar tables may have different tenant boundaries.
- [Extension function resolution](postgres-extension-resolution.md) — production pgcrypto is in extensions; restricted RPCs must qualify its functions.
