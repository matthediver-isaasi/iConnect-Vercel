---
name: Demo tenant seed framework
description: How demo tenants are seeded/reset (demo-seeds/ engine + definitions) and the pitfalls hit building it
---
Demo tenants are seeded by `demo-seeds/engine.mjs` + per-tenant definitions (`demo-seeds/<key>/definition.mjs`) via `scripts/demo-tenant.mjs` (status/seed/reset/delete, --size, --db). Manifest of seeded row ids lives in tenant-scoped `system_settings` key `demo_seed_manifest`.

**Rules learned:**
- All RNG must run in a sequential planning phase; persist in parallel (pmap) afterwards, or determinism breaks.
- `system_settings.setting_value` comes back from PostgREST as a **string** — JSON.parse on read.
- Bulk `member` deletes hit the statement timeout (heavy FK graph) — delete members in small batches with per-row fallback.
- `member_credentials` is unique on (tenant,email) — upsert by email, not member_id, or stale rows from deleted members collide.
- `provisionTenant()` now accepts `skipEmailDomainProvisioning: true` to skip Mailgun/DNS; welcome emails only fire from the platform HTTP handler, not the service.
- `member_membership_history.payment_status` is DB-constrained to unpaid|paid|partial|voided — model refunds as voided+note, waived as paid with final_cost 0.
- Seeding writes direct via supabase-js only (never the entity API) so no workflows/emails/Zoho fire.

**How to apply:** new demo tenants = new definition module only; reuse the engine. AESP tenant slug `aesp` on DEST, seed version aesp-v1.
