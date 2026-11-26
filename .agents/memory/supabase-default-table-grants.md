---
name: Supabase default table grants
description: Read-only or narrow column grants must remove default broad service-role table grants first.
---

When restricting server writes to selected columns or making a server-only table read-only, explicitly revoke inherited/default table privileges from service_role before granting the intended access.

**Why:** Supabase default privileges can grant service_role full table access at creation. Adding UPDATE grants on only cache columns, or granting SELECT alone on provenance tables, does not remove existing write privileges. A clean local fixture without those defaults can misleadingly pass.

**How to apply:** Include production-like default privileges in migration fixtures and verify effective has_table_privilege and has_column_privilege results after application, not merely the written GRANT statements. For read-only provenance, prove SELECT is allowed and all direct mutation privileges are denied; SECURITY DEFINER owners can still perform the approved writes.
