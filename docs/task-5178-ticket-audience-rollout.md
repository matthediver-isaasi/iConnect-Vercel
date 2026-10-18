# Task 5178: selected-member ticket storage rollout

## Application verification

- Production bundle: `npm run build` passed (existing large-chunk warnings).
- Focused policy, booking/payment, serializer, generic entity read/write,
  search, allocation and migration-runner tests passed using isolated fixtures.
- Existing public/group booking regressions: 46 passed.
- Browser fixtures: 19 passed, including actual simple/complex create/edit
  save payloads and reopen hydration, login/logout/account changes, mixed
  tickets/carts, track visibility, legacy empty pricing, and purchased private
  allocation redemption.
- Database guards were exercised in a disposable PostgreSQL 16 cluster only.
- The running preview starts, and the new member-search route rejects an
  unauthenticated request with 401. Its landing page reports
  `Public API Error (404): Tenant not found`; runtime logs show that the
  workspace database lacks the tenant table. A live signed-in editor or
  member checkout was therefore **not verified**.
- No live payment, notification, deployment, or live database write was made.

## Status and evidence

**PENDING on live DEST. No live migration or external write was performed.**
The application must not enable selected-member writes until the schema below
has been applied and independently verified. Local passing tests are not
evidence that production has these columns/triggers.

- Migration: `supabase/migrations/202612310005_ticket_selected_member_audience.sql`
- Reviewed SHA-256:
  `1df3da1ce2fe2d94a69fb15cfd09c01137532f2c183f5f2e7e7db5d65c05ff33`
- Local validation: **11 tests passed, 0 failed**, including a fresh isolated
  PostgreSQL 16 cluster. No destination connection was used.
- Reproduction:

  ```sh
  node --test api/_lib/ticketAudienceWrite.test.mjs \
    api/_lib/ticketAudienceWrite.postgres.test.mjs \
    scripts/apply-ticket-selected-member-audience-migration.test.mjs
  ```

The PostgreSQL test creates its own temporary cluster and Unix socket, applies
the migration twice, checks catalog verification, and exercises direct database
writes. It requires local `initdb`/`pg_ctl`; it does not use production URLs.

## Contract

- `audience_mode`: `selected_members` or `legacy`; missing/null means legacy.
- `selected_member_ids`: canonical tenant-owned `member.id` UUID array.
  Case is normalized and duplicates removed, preserving first occurrence.
  Empty selected lists **are valid and deny everyone**; the editor should warn,
  not reject the save. Empty lists still require `members_only` visibility and
  still reject conflicting restrictions/provisioning.
- Selected audiences require `visibility_mode=members_only`, no role/group
  restrictions, no `role_match_only`, no contact/member creation and no
  provisioning role. They never fall back to legacy eligibility.
- An explicit switch to legacy/null clears the selected list. Switching back
  with an empty list remains deny-all; no role/group-derived backfill occurs.
- Complex ticket creation checks the parent complex event's canonical
  `tenant_id`. PATCH cannot move an existing class to another event.
- Simple tickets remain in `event.pricing_config.ticket_classes`; complex
  tickets use nullable `audience_mode text` and `selected_member_ids uuid[]`.
- The async API helper `validateTicketAudienceWrite` returns the normalized
  payload and throws errors with both `status` and `statusCode` set to 400.
  Call it after authorization, with the authorized existing row on PATCH, and
  persist its return value. Complex PATCH validates merged row state. Supplied
  simple pricing JSON replaces the old JSON, matching entity persistence;
  string JSON is parsed/validated and retains its string representation.
- No migration UPDATE/backfill runs. Existing legacy null/missing fields are
  preserved. Unrelated event updates do not parse/rewrite historical malformed
  pricing; submitted malformed pricing is rejected explicitly.

## Approved operator sequence: schema before code

1. Review the SQL and run the offline review (no network/database access):

   ```sh
   node scripts/apply-ticket-selected-member-audience-migration.mjs
   ```

   If the printed SHA differs from the reviewed SHA above, stop and re-review
   the migration; do not use a stale hash.

2. Following approval, supply **only** `DEST_DATABASE_URL` and
   `DEST_SUPABASE_URL` through the approved secret channel. The runner reuses the
   project's strict destination pin:
   `lvmzliemqnieeoruhkik.supabase.co`, direct SQL or the approved
   `aws-1-eu-central-1.pooler.supabase.com:5432` user
   `postgres.lvmzliemqnieeoruhkik`. No SOURCE or generic DATABASE_URL fallback is
   accepted. TLS is verified with the Supabase CA; credentials are not logged.

3. An approved operator applies the reviewed migration:

   ```sh
   node scripts/apply-ticket-selected-member-audience-migration.mjs \
     --apply --review-sha256=<exact-reviewed-sha256>
   ```

   Application and catalog checks occur in one transaction, with lock and
   statement timeouts. Failure rolls back. Success notifies PostgREST to reload
   schema and emits JSON evidence containing migration SHA, destination pin,
   column types/defaults, constraint, trigger state and function privileges.
   Save that evidence in the release record; do not substitute this document
   for a live result.

4. Independently verify using the pinned destination in a read-only transaction:

   ```sh
   node scripts/apply-ticket-selected-member-audience-migration.mjs --verify
   ```

   This performs no database write. Both nullable columns must exist with no
   backfill defaults, the mode constraint must be validated, and both BEFORE
   INSERT OR UPDATE guards must be enabled. Guard functions must use a fixed
   search path and must not be PUBLIC-callable.

5. Only after schema verification, deploy server read/booking enforcement and
   API write integration, then enable the editor/selection UI. Check authorized
   ticket saves, tenant-scoped member search, anonymous access, selected versus
   nonselected member booking, forged ticket/attendee payloads, and empty-list
   deny-all behavior. These application checks belong to the owning release
   agent/operator; local storage tests alone do not establish booking security.

## Safety and rollback

Database guards cover direct writes to both storage forms, canonical member
tenant checks, UUID deduplication, empty deny-all lists, incompatible public or
provisioning policy, parent ownership on create and immutable complex parents
and tenants. Trigger functions do not expose member information as public RPCs.
Canonical member rows are share-locked while validating the ticket write.

This additive migration preserves existing legacy rows. Prefer keeping the
schema and guards during a code rollback. **Do not roll back read/booking
enforcement while selected-member rows exist**: older code may treat them as
legacy and broaden access. Disable selected ticket sales or explicitly retire
the selected tickets before any coordinated older-code rollback. Do not drop
the columns/triggers or convert private audiences to legacy automatically.
