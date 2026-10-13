---
name: Supabase default table grants
description: Narrow column grants must remove default broad service-role table grants first.
---

When restricting server writes to selected columns on a new table, explicitly revoke inherited/default table privileges from service_role before granting the intended access.

**Why:** Supabase default privileges can grant service_role full table UPDATE at creation. Adding UPDATE grants on only cache columns does not remove the existing table-wide grant. A clean local fixture without those defaults can misleadingly pass.

**How to apply:** Include production-like default privileges in migration fixtures and verify effective has_column_privilege results on both protected and allowed columns after application, not merely the written GRANT statements.
