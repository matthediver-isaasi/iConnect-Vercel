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
- Reset/delete must tolerate rows the manifest doesn't track (older iterations replace record lists wholesale): plain deletes hit FK violations; blocking children must be cleared recursively, scoped to seeded parent ids. `role` has a protection trigger (disable/enable RPC pair, like the platform tenant-delete flow), and domain triggers (e.g. survey assignments with responses) can legitimately block a reset — surface those, don't bypass.
- Long demo operations recover by re-running the same idempotent action; mutual exclusion needs an ATOMIC token-owned DB lease (system_settings can't serialize NULL-tenant rows — NULLs are distinct in unique constraints).
- Survey tables have DB-level guards: `survey_version` is append-only (trigger blocks UPDATE/DELETE even for service role — insert-only upserts, reset must skip it) and `event_survey_assignment` refuses deletion while responses exist (zero its cached count and delete after form_submission). Never pre-seed trigger-maintained cached counters — insert children first, then set caches from actual aggregates once.
- Deletes/writes against DEST can time out or hang transiently under load (supabase-js has no fetch timeout); retry with backoff or kill-and-rerun — the reset is resumable because the manifest only clears at the end.
- Demo tenants on DEST are shared state: concurrent sessions can reset or even delete/recreate the tenant mid-run; confirm rows are stable before diagnosing seed bugs.
- Reseed after tenant provisioning leaves provision-default nav rows alongside seeded ones — the seed must deactivate the non-demo ones.

**How to apply:** new demo tenants = new definition module only; reuse the engine. AESP tenant slug `aesp` on DEST.

## Provenance-safe member field writes (login-governing fields)
- Fields that govern login/identity (role_id, organization_id) on persona rows must be **fill-null only** — an existing value has no provenance and is never replaced. Enforce at write time with a compare-and-set (`.is('col', null)` on the UPDATE + `.select('id')`, zero rows = another assignment won), not just a read-then-write.
- Seed upserts rewrite every supplied field; for such fields pass `undefined` (supabase-js drops it) and link via the fill-null helper after the upsert.
- Provisioning invariants (e.g. exactly one `is_primary` organisation) belong in a `definition.preflight({sb, tenantId})` hook the engine runs BEFORE its own tenant marker/branding writes — fail-fast with zero partial mutation. Resolve, never create; throw on 0 or >1 matches.

## Demo member avatars
AI headshots live in the public `demo-avatars` bucket at a deterministic path (`tenantId/sha1(lowercased email).jpg`) so re-generation overwrites. The seed CANNOT generate images — `demo-seeds/avatars.mjs` only links members to already-uploaded headshots (fill-null CAS on `profile_photo_url`, tenant + `is_sample=true` scoped) and warns about missing ones; generation runs agent-side via generateImage jobs. Eligibility must require `is_sample=true` AND the demo email domain — domain alone would touch manually-created placeholders.
