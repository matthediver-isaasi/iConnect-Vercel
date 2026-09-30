---
name: Optional preference writability metadata
description: Schema-compatible reads must preserve optional field restrictions without requiring their columns.
---

Preference writability metadata is not a guaranteed schema contract. Preserve restrictions supplied by the database without explicitly projecting speculative columns, and keep query failures fail-closed.

**Why:** Linked-member mapping validation introduced explicit optional-column reads that caused valid Due Diligence saves to fail with PostgreSQL 42703. Dropping metadata altogether would instead weaken validation.

**How to apply:** Use schema-compatible definition reads, and make database mocks validate projections and return only selected columns so tests catch both nonexistent columns and accidentally omitted restrictions.