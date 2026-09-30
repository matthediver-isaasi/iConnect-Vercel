---
name: Organisation Group CRM parity
description: Pattern for giving another entity the org-style CRM record treatment (custom fields, layout, visibility rules) and its authorization boundaries.
---

- `preference_field.entity_scope` is guarded by a Postgres CHECK constraint — a new scope needs a migration that recreates the constraint; it is NOT free text.
- Custom-value tables for admin-only record views must be READ-ONLY through the generic entity API (writes 403), with all writes routed through a dedicated upsert endpoint that checks admin access and validates the record and field both belong to the caller's tenant and the field carries the matching entity_scope. Tenant-scoping the row alone is not authorization.
- `PreferenceField` mutations are admin-gated server-side in the generic API; the Custom Fields page gate is client-side only and never an authorization boundary.
- The org detail layout/rules editors are parameterised via a `coreFields` prop; rule evaluation is entity-agnostic over `core:`/`custom:` field ids, so new entities reuse the evaluator instead of forking it.

**Why:** a completion review rejected relying on the generic API's tenant filter — any authenticated member could write group values/definitions until explicit gates were added.
**How to apply:** any future entity wanting the CRM record treatment should copy this generalisation (scoped value table + guarded upsert + read-only generic API + coreFields-parameterised editors), not the org files.
