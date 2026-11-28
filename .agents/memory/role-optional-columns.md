---
name: role table optional columns
description: The live role table lacks some requirement columns that code and SQL treat as optional.
---
Rule: the live `role` table has no `requires_organization` column (checked 2026-11-28). Never name it in a PostgREST select; read whole rows and treat a missing column as "requirement does not apply" (the booking SQL already reads it via JSON with a false default).

**Why:** naming it made every save of an event with a "create member records" ticket fail with ROLE_VALIDATION_UNAVAILABLE (503).

**How to apply:** before adding a role column to a select, confirm it exists in the DEST database's information_schema.
