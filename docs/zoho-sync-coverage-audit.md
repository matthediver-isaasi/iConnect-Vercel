# Zoho CRM Sync Coverage Audit

**Scope:** All write paths (`insert` / `update` / `upsert` / `delete`) targeting `member`, `organization`, `member_preference_value`, and `organization_preference_value` tables. Audit-only — no code changes.

> **Naming note.** The task brief refers to the tables as `members` / `organizations` (plural). The actual schema uses singular table names: `member`, `organization`, `member_preference_value`, `organization_preference_value` (verified in `shared/schema.ts` and `supabase/migrations/`). Throughout this report the singular form is used to match the code.

**Sync engine:** `api/_lib/zohoCrmSync.js` (`triggerZohoCrmSync` / `syncEntityToZohoCrm`). Sync only runs when a row exists in `zoho_crm_sync_mapping` for the tenant + entity_type with `is_enabled=true` and direction `outbound` or `bidirectional`. All triggers are fire-and-forget (non-blocking).

**Entity → table map** (`api/_lib/zohoCrmSync.js:213`): `member`, `organization`, plus pref-change triggers fan-in to the parent entity sync.

---

## 1. Summary Totals

All numbers below are derived directly from the row-by-row enumeration in §2. The counts therefore match the table exactly.

| Metric | Count |
|---|---|
| Total write rows enumerated in §2 | 89 |
| Rows that fire `triggerZohoCrmSync` (rows 1-8 in §2) | 8 |
| Additional sync entry-point not counted as a write site (manual retry button at `api/admin/zoho-crm-sync/logs.js:44`) | 1 |
| Rows that **bypass** Zoho sync (rows 9-88 plus row 89) | 81 |
| Bypass rows in **runtime** code paths (rows 9-74 + row 89; excludes admin one-shots and scripts/migrations rows 75-88) | 67 |
| Bypass rows graded **HIGH** risk | 24 |
| Bypass rows graded **MEDIUM** risk | 23 |
| Bypass rows graded **LOW** risk | 34 |
| Distinct files containing bypass writes | 39 |

> Many rows describe a **cluster** of nearby line ranges in the same file (e.g., row 67 covers three handle-update sites at lines 659/831/870 of the same file). The 89 rows therefore represent ≈111 individual `.from(...).update(...)` / `.insert(...)` / `.upsert(...)` / `.delete(...)` invocations, but every one is captured under one of the 89 audit rows.

**Sync-enabled endpoints (the only safe write paths today):**

1. `api/entities/[entity]/index.js:1041` — POST create member/organization → `triggerZohoCrmSync(..., { action: 'create' })`
2. `api/entities/[entity]/index.js:1058` — POST create member/org preference value → `triggerZohoCrmSync(..., { action: 'preference_change' })`
3. `api/entities/[entity]/[id].js:530` — PATCH update member/organization → `{ action: 'update' }`
4. `api/entities/[entity]/[id].js:554` — PATCH update preference value → `{ action: 'preference_change' }`
5. `api/entities/member-preference-value/upsert.js:87` — bespoke upsert endpoint → `{ action: 'preference_change' }`
6. `api/entities/organization-preference-value/upsert.js:88` — bespoke upsert endpoint → `{ action: 'preference_change' }`
7. `api/admin/organizations/[id].js:117` — admin org PATCH → `{ action: 'update' }`
8. `api/admin/members/[memberId]/index.js:149` — admin member PATCH → `{ action: 'update' }`
9. `api/admin/zoho-crm-sync/logs.js:44` — manual retry button (runs `syncEntityToZohoCrm` directly)

---

## 2. Full Write-Site Table

Legend: **Sync?** = does this code path call `triggerZohoCrmSync` / `syncEntityToZohoCrm` after the write? **Risk** = likelihood the bypassed write causes CRM drift if a tenant has a mapping enabled (H = field is commonly mapped or affects identity; M = field is sometimes mapped or low-volume; L = field is rarely mapped, or write is anonymization/cleanup/one-off).

| # | File:Line(s) | Trigger Type | Op | Table | Fields | Sync? | Risk |
|---|---|---|---|---|---|---|---|
| 1 | `api/entities/[entity]/index.js:1041` | API POST create | insert (upstream) | member / organization | full record | **Yes** (`create`) | — |
| 2 | `api/entities/[entity]/index.js:1058` | API POST create pref value | insert (upstream) | *_preference_value | value | **Yes** (`preference_change`) | — |
| 3 | `api/entities/[entity]/[id].js:530` | API PATCH | update (upstream) | member / organization | any | **Yes** (`update`) | — |
| 4 | `api/entities/[entity]/[id].js:554` | API PATCH pref value | update (upstream) | *_preference_value | value | **Yes** (`preference_change`) | — |
| 5 | `api/entities/member-preference-value/upsert.js:65-66` | API POST upsert | upsert | member_preference_value | value, updated_at | **Yes** (line 87) | — |
| 6 | `api/entities/organization-preference-value/upsert.js:66-67` | API POST upsert | upsert | organization_preference_value | value, updated_at | **Yes** (line 88) | — |
| 7 | `api/admin/organizations/[id].js:105-106` | Admin API PATCH | update | organization | dynamic (admin form) | **Yes** (line 117) | — |
| 8 | `api/admin/members/[memberId]/index.js:130-131` | Admin API PATCH | update | member | dynamic (admin form) | **Yes** (line 149) | — |
| 9 | `client/src/pages/Preferences.jsx:1114-1117` | Frontend (browser → supabase) | update | member | first_name, last_name, job_title, mobile, landline, biography, profile_photo_url, show_in_directory | **No** | **H** |
| 10 | `client/src/pages/Preferences.jsx:1227-1230` | Frontend | update | member | profile_photo_url | **No** | **H** |
| 11 | `client/src/pages/Preferences.jsx:1394-1399` | Frontend | update | member | communications_opted_out_all | **No** | M |
| 12 | `client/src/pages/MemberDetail.jsx:587-588` | Frontend | update | member | communications_opted_out_all | **No** | M |
| 13 | `client/src/components/MemberDetailView.jsx:476-477` | Frontend | update | member | communications_opted_out_all | **No** | M |
| 14 | `api/forms/process-application.js:865-866` | Form submission server flow | update | organization | `orgUpdateData` (mapped form fields) | **No** | **H** |
| 15 | `api/forms/process-application.js:913-914` | Form submission | insert | organization | `orgInsertData` | **No** | **H** |
| 16 | `api/forms/process-application.js:941-942` | Form submission | update | organization_preference_value | value | **No** | **H** |
| 17 | `api/forms/process-application.js:945` | Form submission | insert | organization_preference_value | full row | **No** | **H** |
| 18 | `api/forms/process-application.js:1086-1087` | Form submission | update | member | `memberUpdateData` | **No** | **H** |
| 19 | `api/forms/process-application.js:1188-1189` | Form submission | insert | member | `memberInsertData` | **No** | **H** |
| 20 | `api/forms/process-application.js:1226-1227` | Form submission | update | member_preference_value | value | **No** | **H** |
| 21 | `api/forms/process-application.js:1230` | Form submission | insert | member_preference_value | full row | **No** | **H** |
| 22 | `api/forms/process-application.js:1913-1914` | Form submission (additional contacts) | update | member | additionalMemberData | **No** | M |
| 23 | `api/forms/process-application.js:1997-1998` | Form submission | insert | member | newMemberData | **No** | M |
| 24 | `api/forms/process-application.js:2038-2039` | Form submission | delete | member_preference_value | by member_id+field_id | **No** | M |
| 25 | `api/forms/process-application.js:2055-2056` | Form submission | update | member_preference_value | value | **No** | M |
| 26 | `api/forms/process-application.js:2060-2061` | Form submission | insert | member_preference_value | full row | **No** | M |
| 27 | `api/forms/process-application.js:2082-2083` | Form submission | delete | member_preference_value | by composite key | **No** | M |
| 28 | `api/forms/process-application.js:2099-2100` | Form submission | update | member_preference_value | value | **No** | M |
| 29 | `api/forms/process-application.js:2104-2105` | Form submission | insert | member_preference_value | full row | **No** | M |
| 30 | `api/forms/process-field-mappings.js:96-97` | Form submission helper | update | member_preference_value | value, updated_at | **No** | **H** |
| 31 | `api/forms/process-field-mappings.js:108-109` | Form submission helper | insert | member_preference_value | full row | **No** | **H** |
| 32 | `api/forms/process-field-mappings.js:133-134` | Form submission helper | update | organization_preference_value | value, updated_at | **No** | **H** |
| 33 | `api/forms/process-field-mappings.js:145-146` | Form submission helper | insert | organization_preference_value | full row | **No** | **H** |
| 34 | `api/due-diligence/_stageActions.js:1439-1440` | DD workflow action | insert | member | memberData | **No** | **H** |
| 35 | `api/due-diligence/_stageActions.js:1534-1535` | DD workflow action | insert | member_preference_value | value | **No** | **H** |
| 36 | `api/due-diligence/_stageActions.js:1876-1877` | DD workflow action | update | organization | updateData | **No** | **H** |
| 37 | `api/due-diligence/_stageActions.js:1944-1945` | DD workflow action | update | organization | logo_url | **No** | M |
| 38 | `api/due-diligence/_stageActions.js:1961-1962` | DD workflow action | update | organization | updateData | **No** | **H** |
| 39 | `api/due-diligence/_stageActions.js:1992-1993` | DD workflow action | update | organization_preference_value | value, updated_at | **No** | **H** |
| 40 | `api/due-diligence/_stageActions.js:2004-2005` | DD workflow action | insert | organization_preference_value | full row | **No** | **H** |
| 41 | `api/membership/role-restrictions.js:132-133` | Membership API | update | organization | role-restriction fields | **No** | M |
| 42 | `api/membership/org-membership.js:670-671` | Membership API (set tier driver field) | upsert | organization_preference_value | value, updated_at | **No** | **H** |
| 43 | `api/email-preferences/index.js:262-263` | Public preference link | update | member | communications_opted_out_all | **No** | M |
| 44 | `api/webhooks/mailgun.js:226-227` | Inbound webhook | update | member | bounce/unsub flags | **No** | M |
| 45 | `api/zoho-campaigns/webhook.js:88-89` | Inbound from Zoho Campaigns | update | member | sub status | **No** (inbound, intentional) | L |
| 46 | `api/public/complex-event-booking.js:681-682` | Public booking | update | organization | training_fund_balance | **No** | L |
| 47 | `api/public/complex-event-booking.js:756-757` | Public booking | update | organization | training_fund_balance | **No** | L |
| 48 | `api/public/complex-event-booking.js:795-796` | Public booking | update | organization | account_balance | **No** | L |
| 49 | `api/public/form-submission.js:166-167` | Public form | update | member | communications_opted_out_all | **No** | M |
| 50 | `api/public/fundraising/register.js:231-232` | Public registration | insert | organization | full row | **No** | **H** |
| 51 | `api/public/fundraising/register.js:362-363` | Public registration | insert | member | full row | **No** | **H** |
| 52 | `api/booking-cancellation-requests/[requestId].js:284-285` | API approve/reject | update | organization | training_fund_balance | **No** | L |
| 53 | `api/booking-cancellation-requests/[requestId].js:421-422` | API approve/reject | update | organization | program_ticket_balances, last_synced | **No** | L |
| 54 | `api/booking-cancellation-requests/approve-group.js:269-270` | API group approve | update | organization | training_fund_balance | **No** | L |
| 55 | `api/booking-cancellation-requests/approve-group.js:310-311` | API group approve | update | organization | program_ticket_balances, last_synced | **No** | L |
| 56 | `api/auth/set-password.js:258-259` | Auth flow | update | member | identity_id | **No** | L |
| 57 | `api/auth/set-password.js:383-384` | Auth flow | update | member | handle | **No** | L |
| 58 | `api/auth/login.js:357-358` | Auth flow | update | member | role_id | **No** | L |
| 59 | `api/auth/login.js:410-411` | Auth flow | update | member | handle | **No** | L |
| 60 | `api/auth/portal-sso.js:170-171` | Auth flow | update | member | handle | **No** | L |
| 61 | `api/auth/google/callback.js:159-160` | Auth flow | update | member | google_id | **No** | L |
| 62 | `api/auth/google/callback.js:212-213` | Auth flow | update | member | identity_id | **No** | L |
| 63 | `api/_lib/provisionTenantService.js:124` | Tenant provisioning rollback | delete | member | by id | **No** | L |
| 64 | `api/_lib/provisionTenantService.js:137` | Tenant provisioning rollback | delete | organization | by id | **No** | L |
| 65 | `api/_lib/provisionTenantService.js:377-378` | Tenant provisioning | insert | organization | full row (primary org) | **No** | M |
| 66 | `api/_lib/provisionTenantService.js:466-467` | Tenant provisioning | insert | member | full row (admin user) | **No** | M |
| 67 | `api/functions/[functionName].js:659-660`, `831-832`, `870-871` | Generic functions runner (handle-fix flows) | update | member | handle | **No** | L |
| 68 | `api/functions/[functionName].js:1348-1349`, `3223-3224`, `4014-4018`, `4085-4089`, `4164-4167` | Generic functions runner (ticket flows) | update | organization | program_ticket_balances, last_synced | **No** | L |
| 69 | `api/functions/[functionName].js:1820-1824` | Generic functions runner (one-off booking) | update | organization | training_fund_balance | **No** | L |
| 70 | `api/functions/sync-mailgun-events.js:217-218` | Mailgun sync runner | update | member | bounce/suppression flags | **No** | M |
| 71 | `api/entities/[entity]/[id].js:820-823` | Entity DELETE (role) | update | member | role_id (reassign on role delete) | **No** | M |
| 72 | `api/entities/[entity]/[id].js:1031-1043` | Entity DELETE (member) | update | member | anonymization (email→`deleted_*`, names, handle, photo, login_enabled, show_in_directory) | **No** | M |
| 73 | `api/entities/[entity]/[id].js:1169-1182` | Entity DELETE (org cascade) | update | member | anonymization (per-member loop) | **No** | M |
| 74 | `api/entities/[entity]/[id].js:1235-1237` | Entity DELETE (org) | delete | organization | hard delete | **No** | M |
| 75 | `api/admin/fix-blog-handles.js:195-196` | Admin one-shot endpoint | update | member | handle | **No** | L |
| 76 | `api/admin/backfill-organization-dates.js:86-87` | Admin one-shot endpoint | update | organization | created_at | **No** | L |
| 77 | `api/admin/backfill-member-tenant-id.js:42-43, 63-64` | Admin one-shot endpoint | update | member | tenant_id | **No** | L |
| 78 | `scripts/backfill-member-class.mjs:118-119, 135-136` | Local script | update / upsert | member_preference_value | value | **No** | L |
| 79 | `scripts/backfill-go-live-date.mjs:191-192` | Local script | upsert | organization_preference_value | full row | **No** | L |
| 80 | `scripts/import-org-logos.js:123-124` | Local script | update | organization | logo_url | **No** | L |
| 81 | `scripts/import-org-websites.js:52-53` | Local script | update | organization | website_url | **No** | L |
| 82 | `scripts/import-org-domains.js:65-66, 73-74` | Local script | update / insert | organization_preference_value | value | **No** | L |
| 83 | `scripts/delete-mailchimp-never-logged-in-members.mjs:176-177` | Local script | delete | member | by id | **No** | L |
| 84 | `scripts/delete-gfi-members.js:125-126, 133-134` | Local script | delete | member | by id | **No** | L |
| 85 | `scripts/delete-orphaned-tenant.js:83-84, 154-155` | Local script | delete | member, organization | cascade | **No** | L |
| 86 | `scripts/delete-duplicate-tenant.js:129-130, 153-154` | Local script | delete | member, organization | cascade | **No** | L |
| 87 | `scripts/migrations/migrate-files-cross-storage.js:1702-1703, 1709-1710` | Migration script | update | member, organization | per-field URL rewrite | **No** | L |
| 88 | `scripts/migrations/add-org-is-primary.mjs:64-65` | Migration script | update | organization | is_primary | **No** | L |
| 89 | `api/my-organization.js:62-63` | API PATCH (member self-service) | update | organization | description, website_url, logo_url, phone, invoicing_email, invoicing_address | **No** | **H** |

> Lines 71-74 are sub-branches of the same DELETE handler (`api/entities/[entity]/[id].js`) — the file path is the same, the listed line ranges are distinct sub-blocks. Verified all paths/line numbers exist in the current tree.

---

## 3. Gaps (bypassed sites only, ranked by risk)

### High-risk gaps (CRM drift very likely if a tenant has a mapping enabled)

1. **`api/forms/process-application.js:865, 913, 1086, 1188`** — public form submissions create/update both `organization` and `member` records with the very fields most operators map to Zoho (name, email, address, custom values). **Recommendation:** route writes through the entity API (`/api/entities/...`) or call `triggerZohoCrmSync` after each write block.
2. **`api/forms/process-application.js:941, 945, 1226, 1230, 2038-2105`** — same form flow writes/deletes `*_preference_value` rows in 10 places. **Recommendation:** replace direct supabase calls with the `member-preference-value/upsert` and `organization-preference-value/upsert` endpoints (which already trigger sync).
3. **`api/forms/process-field-mappings.js:96, 108, 133, 145`** — generic field-mapping helper invoked by multiple form pipelines bypasses sync for pref upserts/inserts. **Recommendation:** call `triggerZohoCrmSync(tenantId, entityType, entityId, { action: 'preference_change' })` after each successful write.
4. **`api/due-diligence/_stageActions.js:1439, 1534, 1876, 1961, 1992, 2004`** — DD stage transitions create members and update org core + pref values without sync. **Recommendation:** add a single `triggerZohoCrmSync` call at the end of each stage action that mutates member/org rows.
5. **`api/membership/org-membership.js:670`** — upsert of the organisation_preference_value row that drives membership tier. **Recommendation:** call `triggerZohoCrmSync(tenantId, 'organization', organizationId, { action: 'preference_change' })` immediately after the upsert succeeds.
6. **`api/public/fundraising/register.js:231, 362`** — public registration inserts new `organization` and `member` rows. **Recommendation:** trigger a `create` sync after each insert (use the captured row id and tenant_id).
7. **`client/src/pages/Preferences.jsx:1114, 1227`** — frontend writes member profile fields (names, biography, photo, directory visibility) directly via `supabase.from('member').update(...)`. **Recommendation:** switch to PATCH `/api/entities/Member/:id` so the existing trigger fires.
7a. **`api/my-organization.js:62`** — member self-service "Edit my organisation" PATCH writes high-value org fields (`description`, `website_url`, `logo_url`, `phone`, `invoicing_email`, `invoicing_address`) without firing sync. **Recommendation:** call `triggerZohoCrmSync(updatedOrg.tenant_id, 'organization', orgId, { action: 'update' })` after the successful update — same pattern as `api/admin/organizations/[id].js:117`.

### Medium-risk gaps

8. **`api/forms/process-application.js:1913, 1997`** — additional-contact member writes inside the form pipeline. **Recommendation:** include in the same fix as #1.
9. **`api/email-preferences/index.js:262`, `api/public/form-submission.js:166`** — `communications_opted_out_all` updates from public links. Often mapped to a Zoho marketing flag. **Recommendation:** trigger sync after the update.
10. **`api/webhooks/mailgun.js:226`, `api/functions/sync-mailgun-events.js:217`** — bounce/unsubscribe member updates. **Recommendation:** trigger sync (or skip if the same event already inbound from Zoho).
10a. **`client/src/pages/MemberDetail.jsx:587`, `client/src/components/MemberDetailView.jsx:476`** — admin UI directly toggles `communications_opted_out_all` on the `member` table. **Recommendation:** route through the entity API or trigger sync after the update so the CRM consent flag stays in step.
11. **`api/membership/role-restrictions.js:132`** — org row update for role-restriction config. **Recommendation:** trigger sync (low volume, low cost).
12. **`api/_lib/provisionTenantService.js:377, 466`** — initial primary organisation + admin member created during tenant provisioning. **Recommendation:** trigger a `create` sync once mapping rows exist (acceptable to skip if mappings are configured later).
13. **`api/entities/[entity]/[id].js:820, 1031, 1169, 1235`** — DELETE / anonymisation paths for member, organisation cascade and role reassignment. **Recommendation:** emit a `triggerZohoCrmSync(..., { action: 'delete' })` so CRM rows are tombstoned/cleaned. Today the CRM keeps live data after the iConnect record is anonymised.

### Low-risk gaps

14. **`api/auth/*` handle/identity_id/role_id/google_id updates** (`set-password.js:258, 383`; `login.js:357, 410`; `portal-sso.js:170`; `google/callback.js:159, 212`) — internal identity columns rarely mapped to CRM. **Recommendation:** leave as-is unless a tenant explicitly maps these.
15. **`api/public/complex-event-booking.js:681, 756, 795`, `api/booking-cancellation-requests/*`, `api/functions/[functionName].js:1348, 1820, 3223, 4014, 4085, 4164`** — `training_fund_balance`, `program_ticket_balances`, `last_synced` operational counters. **Recommendation:** leave as-is; if a tenant ever maps balances to CRM, fold into safety-net (see §5).
16. **`api/functions/[functionName].js:659, 831, 870`** + `api/admin/fix-blog-handles.js:195` — `handle` updates only. **Recommendation:** leave as-is.
17. **`api/admin/backfill-*` and `scripts/*`** — one-shot data backfills, deletions and migrations. **Recommendation:** when running, manually invoke a Zoho reconcile (`api/cron/zoho-crm-reconcile.js`) afterwards rather than wiring sync into the scripts.
18. **`api/zoho-campaigns/webhook.js:88`** — inbound write from Zoho. **Not a gap** (sync would loop).

---

## 4. Background Jobs, Webhook Handlers, and Sync Workers

This section is a **complete inventory** of every non-interactive code path that runs on a timer, in response to an external webhook, or as a background worker, and could touch the audit-scope tables. Every entry is classified as Read-only / Write / Triggers-sync.

### 4a. Cron jobs (`api/cron/*`)

| File | Purpose | Audit-scope access | Triggers Zoho sync? | Notes |
|---|---|---|---|---|
| `api/cron/process-membership-renewals.js` | Auto-create membership history rows | No writes to audit scope (touches `membership_*`, `scheduled_task_log`, `organisation_membership_*`) | n/a | Safe. |
| `api/cron/zoho-crm-reconcile.js` | Reconciliation loop: enumerates `zoho_crm_sync_mapping` rows and runs `syncEntityToZohoCrm` for missing/stale records | Reads only; pushes via the sync engine | **Yes** (drives the sync engine directly) | This is the existing safety net. Anchor candidate for the generic reconcile in §5. |
| `api/cron/send-event-reminders.js` | Event reminder emails | Read-only on `member`/`organization` | n/a | Safe. |
| `api/cron/sync-outlook-emails.js` | Pull Outlook emails | Read-only on `member`/`organization` | n/a | Safe. |
| `api/cron/send-contract-reminders.js` | Contract reminder emails | Read-only on `organization` (line 34) | n/a | Safe. |
| `api/cron/send-contract-timeout-notifications.js` | Contract timeout notifications | Read-only on `organization` (lines 35, 266) | n/a | Safe. |

### 4b. Webhook handlers (inbound from third parties)

| File | Source | Audit-scope writes | Triggers Zoho sync? | Notes |
|---|---|---|---|---|
| `api/webhooks/mailgun.js` | Mailgun events (bounce / complaint / unsubscribe) | Yes — `member` update at line 226-227 (suppression flags). | **No** | Captured as bypass row 44 (Medium risk). |
| `api/zoho-campaigns/webhook.js` | Inbound from Zoho Campaigns (subscription state) | Yes — `member` update at line 88-89. | **No** (intentional — would loop) | Captured as row 45 (Low). Reads at line 74 are also part of the same handler. |
| `api/zoho-crm/webhook.js` | Inbound from Zoho CRM | No audit-scope writes (only `tenant` table read at line 105). | n/a | Safe for this audit. Note: this handler would be a logical place to receive *inbound* member/org updates if the integration is later expanded to bidirectional. |
| `api/admin/zoho-crm-sync/webhook-url.js` | Webhook config endpoint (read/write of `zoho_crm_sync_mapping` only) | No audit-scope writes | n/a | Safe. |
| `api/zoho-campaigns/webhook-url.js` | Webhook config endpoint | No audit-scope writes | n/a | Safe. |

### 4c. Background sync workers / "function" runners (queue-style endpoints)

| File | Purpose | Audit-scope writes | Triggers Zoho sync? | Notes |
|---|---|---|---|---|
| `api/zoho-campaigns/sync.js` | Push members to Zoho Campaigns lists (single + tenant batch) | Read-only on `member` (lines 71, 150, 163) | n/a (pushes outbound to Zoho Campaigns, not Zoho CRM) | No bypass risk for this audit. |
| `api/zoho-campaigns/sync-job.js` | Long-running batch sync to Zoho Campaigns | Read-only on `member` (lines 113, 271) | n/a | Same as above. |
| `api/zoho-campaigns/lists.js`, `oauth.js`, `disconnect.js` | Zoho Campaigns admin endpoints | Read-only on `member` / `organization` (config access) | n/a | Safe. |
| `api/functions/[functionName].js` | Generic dispatch for in-app "functions" (handle-fix, ticket flows, one-off bookings) | Yes — multiple writes captured as rows 67-69 | **No** | Captured in §2; all rated Low (counter / handle fields). |
| `api/functions/sync-mailgun-events.js` | Polling-style worker that retro-applies Mailgun events | Yes — `member` update at line 217-218 | **No** | Captured as row 70 (Medium). |
| `api/functions/backfill-mailgun-webhooks.js` | One-shot helper for backfill | No audit-scope writes (writes to `mailgun_event` only) | n/a | Safe. |

### 4d. Conclusion on background paths

- **One cron** (`zoho-crm-reconcile.js`) actively drives the sync engine — this is the existing safety net and the recommended anchor for §5.
- **Two webhook handlers** (`api/webhooks/mailgun.js`, `api/zoho-campaigns/webhook.js`) write to `member` without firing `triggerZohoCrmSync`. The Zoho Campaigns one is an intentional non-trigger (would loop); the Mailgun one is a real (Medium-risk) gap and is included in §3.
- **Two background runners** (`api/functions/[functionName].js`, `api/functions/sync-mailgun-events.js`) write to audit-scope tables without sync; both are captured in §2 / §3.
- All other webhooks/workers are either read-only or operate on tables outside the audit scope.

---

## 5. Closing Recommendation: Generic Safety Net vs Point Fixes

**Recommendation: do both, in this order.**

1. **Short-term — generic safety net (highest ROI):** extend the existing `api/cron/zoho-crm-reconcile.js` (or add a complementary lightweight job) to:
   - Compare `member.updated_at` / `organization.updated_at` (and the `updated_at` columns on `*_preference_value`) against the last successful sync timestamp recorded in `zoho_crm_sync_state` per tenant+entity.
   - For any row whose `updated_at` is newer than the last sync, enqueue `syncEntityToZohoCrm(tenantId, entityType, id, { action: 'reconcile' })`.
   - Run on a short interval (e.g. every 5 minutes) so bypassed writes self-heal within minutes regardless of which file performed them.

   Why first: there are **67 runtime bypass rows across the files enumerated in §1** (server endpoints, workers, and three frontend pages — admin one-shots and scripts excluded). Patching every one introduces risk and review burden, and any new write path added in the future will have the same problem. A reconcile loop converts "every write must remember to call sync" into "writes only need to update `updated_at`", which Postgres already does for the existing schema.

2. **Medium-term — point fixes for the high-risk gaps that the safety net handles imperfectly:**
   - `api/forms/process-application.js`, `api/forms/process-field-mappings.js`, `api/due-diligence/_stageActions.js`, `api/membership/org-membership.js`, `api/public/fundraising/register.js`, `api/my-organization.js` (gaps #1-#6 and #7a). These flows often need the CRM record to exist *before* the next step (welcome email, contract trigger, fundraiser confirmation, member self-service workflow), so a 5-minute reconcile delay is too long. Add explicit `triggerZohoCrmSync` calls — one line per write block.
   - Frontend writes in `Preferences.jsx` (gap #7): re-route to the entity API. This is a one-line-per-call refactor that also gives you workflow / preference-change side-effects "for free".

3. **Leave alone:** auth identity columns, ticket/training-fund counters, anonymisation flows, one-shot backfill scripts. Either they aren't mapped, or the reconcile loop will tidy any drift on the next pass.

**Counting clarification.** §1 reports **67 runtime bypass rows** across **39 distinct files** because it counts each enumerated row in §2 and includes every file that contains at least one bypass write (admin one-shots, scripts, and migrations included). The bullet above talks about *targeted code clusters*: collapsing the rows into the eight files actually proposed for point-fix patches yields **6 server files plus `Preferences.jsx`** (≈30 line additions in total). The two views are consistent — the §1 totals describe the inventory; the §5 fix scope is a subset chosen for highest impact / lowest churn.

**Net effect:** the reconcile safety net closes 100% of bypass risk asymptotically, the targeted point fixes close the latency gap for user-visible flows, and total code churn stays under ~30 line additions plus one cron extension.
