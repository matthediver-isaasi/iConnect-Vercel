# Demo Tenant Seeder Framework

A reusable, definition-driven framework for seeding fully populated demo
tenants into iConnect, plus the first definition: **AESP** (Association of
Environmental & Sustainability Professionals).

## Layout

```
demo-seeds/
  engine.mjs            Generic seed engine (RNG, upserts, manifest, reset/delete)
  aesp/definition.mjs   AESP tenant definition (seed version aesp-v1)
scripts/demo-tenant.mjs CLI: status | seed | reset | delete
```

## Usage

```bash
# Fixed persona password (recommended; otherwise a random one is printed once)
export DEMO_SEED_PASSWORD='...'

node scripts/demo-tenant.mjs aesp status
node scripts/demo-tenant.mjs aesp seed            # create/refresh (idempotent)
node scripts/demo-tenant.mjs aesp reset           # remove seeded rows, reseed
node scripts/demo-tenant.mjs aesp delete          # remove the entire tenant
node scripts/demo-tenant.mjs aesp seed --size=medium   # 1,000 members (large=6,500)
```

The CLI targets the production (DEST) database by default; `--db=dev` uses
`DEV_SUPABASE_URL`. It repoints `SUPABASE_URL`/`SUPABASE_SERVICE_KEY` before
importing any api/_lib module so the shared client hits the right database.

## Framework design

- **Definition-driven** — a definition module supplies tenant identity,
  branding, and an async `seed(ctx)` that describes data. The engine supplies
  everything safety-critical. Future demo tenants (community club,
  org-centric trade body) need only a new `demo-seeds/<key>/definition.mjs`.
- **Deterministic** — fixed string seed → mulberry32 RNG. All RNG runs in a
  sequential planning phase; persistence is parallel (bounded concurrency)
  but the data is already fixed, so re-runs generate the identical dataset.
- **Idempotent** — every row is upserted on a stable natural key (member
  email, org name, config name, `(member, year)` for history…). Re-running
  never duplicates.
- **Manifest** — each run stores `{ seedKey, version, lastSeededAt, counts,
  records: { table: [ids] } }` in `system_settings`
  (`setting_key='demo_seed_manifest'`, tenant-scoped). `reset` deletes exactly
  those ids (reverse insertion order, always additionally filtered by
  tenant_id where the column exists). `delete` refuses to run unless the
  tenant is marked as a demo tenant, then removes all tenant-scoped rows, the
  tenant itself, and any identities left with no other tenant memberships.
- **Sizes** — definitions expose small/medium/large (120 / 1,000 / 6,500 for
  AESP) via `--size`; no engine changes needed.

## Safety / zero external side effects

- All writes are **direct supabase-js table writes** with the service key —
  the entity API layer (which fires workflows, emails, Zoho sync) is never
  used, and there are no DB triggers that send anything.
- Tenant provisioning reuses `provisionTenant()` from
  `api/_lib/provisionTenantService.js` with a new
  `skipEmailDomainProvisioning: true` option (added for this task) so no
  Mailgun domain or DNS records are created. The welcome/setup emails live
  only in the platform HTTP handler (`api/platform/tenants/provision.js`),
  which is bypassed entirely.
- No Stripe / GoCardless / Xero / Zoom / Zoho calls anywhere in the engine or
  definitions. Payment history is synthetic data in
  `member_membership_history` only.
- Every write and delete is scoped to the demo tenant id. Tables without a
  tenant column (`member_preference_value`) are handled via manifest-recorded
  ids only.
- All emails are on `aesp.example.com` (IANA-reserved, cannot deliver).
  All members/orgs carry `is_sample = true`. All people are fictional.
- No plaintext credentials are committed. Persona passwords come from
  `DEMO_SEED_PASSWORD` or a per-run random value printed once; only bcrypt
  hashes are stored.

## AESP dataset (aesp-v1)

- **Tenant** — slug `aesp`, branding deep forest green `#174A3A` / sage
  `#8FAE98` / ochre `#D5A642` (dark `#29332F`, light `#F5F6F2` in
  `branding_config`), description + tagline, `settings.demo_seed` marker.
- **Tiers** — five flat-priced `membership_tier_config` rows scoped by a
  "Membership Grade" preference field: Student £35, Graduate £85,
  Professional £175 (MAESP), Fellow £245 (FAESP), Retired £70.
- **Organisations** — 28 fictional employers across consultancies, local
  authorities, universities, energy, utilities, NGOs, government.
- **Members** — 122 (small size): 7 personas + 3 admin personas + generated
  fill, with weighted grade distribution, diverse UK names, regions,
  job titles, `AESP-####` membership numbers, interests, qualifications and
  varied communication preferences across 4 categories. Lifecycle mix:
  active / recently renewed / renewal due soon / overdue / awaiting payment /
  pending application / lapsed / cancelled — all dates relative to run date.
- **History** — ~434 `member_membership_history` rows (≤5 years back per
  member) at tier prices with paid/unpaid/voided(refund)/waived-£0 payment
  states, plus matching `member_membership_invoicing` rows
  (`invoicing_mode='automatic'`, `fees_approved=true`).
- **Personas** — Sarah Mitchell (Professional, active, login), Dr James
  Walker (Fellow, active, login), Aisha Rahman (Graduate, active, login),
  Chloe Evans (Student, active), Peter Langford (Retired, active), Daniel
  Brooks (Professional, renewal overdue, login), Emily Foster (pending
  application, no history). Admins: Hannah Clarke (Chief Executive, tenant
  owner/Super Admin), Rebecca Collins (Membership Manager role — no events or
  platform settings), Thomas Reed (Events & CPD Manager role — no membership
  finance).

## Entities reused (no new data model)

`tenant`, `tenant_identity`, `tenant_membership(+credentials)`, `tenant_user`,
`role`, `organization`, `member`, `member_credentials`,
`membership_tier_config`, `member_membership_history`,
`member_membership_invoicing`, `preference_field`, `member_preference_value`,
`communication_category`, `member_communication_preference`,
`system_settings`.

## Omissions & mapping notes

- **CPD and mentoring** — these features do not exist in iConnect; the spec's
  CPD/mentoring datasets are omitted (Thomas Reed's role is titled
  "Events & CPD Manager" for realism only).
- **Refunded / waived payment states** — `payment_status` is DB-constrained
  to `unpaid|paid|partial|voided`. Refunds are represented as `voided` with an
  explanatory note; waived years as `paid` with `final_cost=0` and a note.
- **"Renewal due in N days" per member** — renewal dates are tier-config
  driven (annual, 1 Jan cycle), not per-member columns; "renewal due soon" is
  represented as a current-year unpaid renewal invoice with a due-date note.
- Platform-admin demo tenant console is a separate follow-up task.

## Engagement & content phase (`aesp/engagement.mjs`, aesp-v2)

Phase 3 of the AESP seed — runs after member persistence with its own RNG
stream (`aesp-v1:engagement`) so member data stays byte-stable:

- **6 Special Interest Groups** (Carbon & Net Zero 35, Biodiversity 25, EIA
  20, ESG 30, Renewable Energy 22, Sustainable Construction 18) as
  self-joinable `member_group`s with Chair/Vice Chair/Member roles; members
  can belong to several. Sarah Mitchell is guaranteed into Carbon & Net Zero.
- **6 committees** (AESP Council with President — Dr James Walker — VP,
  Immediate Past President, Treasurer; plus Professional Standards,
  Education & CPD, Events, Membership, Sustainability Policy) with 6–9
  senior members each via `member_group_assignment.group_role`.
- **14 simple events** (9 historical incl. Annual Conference 2025, 5
  upcoming incl. members-only Net Zero webinar with ~40 registrations, paid
  BNG masterclass, early-careers networking, EIA workshop, AGM 2026) with
  373 bookings in mixed states — attended = `checked_in_at` set, no-show =
  past confirmed without check-in, plus cancellations — and synthetic
  card/account payment methods on paid events. **Annual Conference 2026** is
  a `complex_event` (Birmingham, capacity 350, Member £295 / Non-member £395
  ticket classes) with 46 bookings. No emails or payment providers fire —
  all rows written directly with the service key.
- **"Apply for AESP Membership" form** (`is_application_form`, member-level)
  with personal/employment/education/experience fields and visibility rules
  that reveal a recommended-grade panel (Student/Graduate/Professional/
  Fellow) from the studying flag + years-of-experience answer. Emily
  Foster's pending submission (`status='new'`) and Sarah Mitchell's approved
  (`actioned`) historical application are linked to it.
- **Conference feedback survey** (form_type=survey, 4 star ratings + 1–10
  likelihood + comments) with an immutable `survey_version`, an
  `event_survey_assignment` on Annual Conference 2025 and 26 responses
  scored through the app's own `scoreSubmission` engine
  (`form_submission` + `survey_answer` rows).
- **CMS**: 6 published canvas pages (home, about-aesp, membership,
  professional-development, knowledge-hub, policy-advocacy) generated via
  `buildNeutralDesign`; top-nav rebuilt (provision defaults deactivated);
  8 news posts over ~6 months; 6 knowledge resources (CPD Guidance, Code of
  Conduct, Net Zero Practitioner Guide, BNG Briefing, Careers Guide,
  Mentoring Handbook) as external-link records.
- **Activity trail**: Sarah Mitchell has application → approval → payment
  history (phase 2) → SIG join (`member_group_activity` 'joined') → webinar
  registrations with check-ins.

Engagement omissions: **waitlist** bookings (no waitlist feature — no-shows
modelled as un-checked-in confirmed bookings instead); CPD/mentoring as
above. Canvas design node ids are freshly generated per seed run (content
is deterministic; `i_edit_page` rows are matched by slug so no duplicates).
`survey_version` rows are immutable in the DB, so the engine upserts them
insert-only and reuses the existing row on reseed.

## Verification performed

Seeded twice + full reset/reseed against the production database. Confirmed:
stable counts and zero duplicate emails across re-runs; all 10 personas in
their exact states; 5 tiers at spec prices; payment mix
(398 paid / 21 unpaid / 15 voided / 1 waived across 434 rows); branding and
`demo_seed` version marker applied; every email on `aesp.example.com`;
nothing outside the tenant touched (all writes tenant-scoped).
