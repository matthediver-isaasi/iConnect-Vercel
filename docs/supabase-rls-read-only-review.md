# Supabase read-only review — 8–9 October 2026

The owner is considering remediation. No permission or policy changes are authorised.

Reviewed production DEST project lvmzliemqnieeoruhkik using database metadata and code only.
No business records, credential values, writes, or privileged-function execution were needed.
Direct API probes were not performed: public-key retrieval was scanner-blocked, and the owner
approved continuing with metadata and code instead. Internet exploitability and historical
misuse have not been established.

Snapshot findings:
- 234 public-schema tables lacked RLS; 221 granted SELECT/INSERT/UPDATE/DELETE to both anon and authenticated.
- system_settings had a policy but RLS was disabled.
- 22 security-definer functions granted execution to both browser roles. Some are trigger functions,
  and some have internal service-role guards, so they are not equally exploitable.
- Inspected platform_delete_tenant and disable_role_protection_trigger definitions had no caller-authorisation check.
- 24 realtime-published tables lacked RLS.

Impact review:
- Direct browser queries include booking availability counts, member-group eligibility,
  floating panels/forms and resource categories.
- Realtime supports availability, balances and content refreshes.
- Shared backend service-role access bypasses RLS, but each affected path still needs validation.
- Tightening all tables without replacing browser dependencies risks feature regressions.
- Restrict function execution independently of table RLS, including inherited PUBLIC grants;
  preserve authorised backend access.
- Prefer individual functions and tables or small related groups, with isolated verification and
  database rollback plans. Never validate destructive functions against real production records.
- Preview may share production's database; a Git branch is not database isolation.

Recheck live metadata before remediation; these are dated findings, not current guarantees.
