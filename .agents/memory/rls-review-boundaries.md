---
name: RLS review boundaries
description: Owner-approved scope and retained read-only security investigation.
---

The user will consider the RLS issues and return with a decision; do not treat the investigation as approval to change permissions.

**Why:** The user explicitly requested strictly read-only investigation and asked to retain the information.

**How to apply:** Consult `docs/supabase-rls-read-only-review.md` for the dated evidence and limitations. Revalidate before remediation. Database changes need separate approval; preview branches do not isolate a shared production database.
