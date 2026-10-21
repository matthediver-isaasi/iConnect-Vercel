# Task 5226: tenant badge-sharing instructions rollout

## Approval and application status

Migration required: `supabase/migrations/202611100001_tenant_badge_instructions.sql`.
Applied with owner approval on 2026-10-21 to verified DEST
(`lvmzliemqnieeoruhkik`); SOURCE was not changed.
SHA256: `df4d686f836da4f812ac86c69b6ebbc6b152ac0c0183feb3874564badfc33125`.
Verified private bucket, ledger RLS, denied authenticated RPC execution and
allowed service-role RPC execution. The disposable PostgreSQL suite passed.
Graduate Futures Institute had no saved instructions, ledger objects or retained
PDF in the badge-instructions bucket after application; a fresh upload and explicit
PDF-mode save are required. No files were deleted or replaced.

For other environments, apply the migration after approval before deploying the
API and UI together. It requires existing `tenant`, `plan`, `system_settings`,
`storage.buckets`, `storage.objects`, and the existing `storage_used_bytes` counter.
The private `badge-instructions` bucket is created by the migration; no public
bucket or signed browser upload is used.

The partial unique index intentionally fails on pre-existing duplicate
`tenant_badge_instructions` rows. Investigate and reconcile such rows manually
rather than allowing rollout to discard tenant data. Ordinary settings are unchanged.

## Contract

`GET /api/badge-instructions` returns `{tenantId,mode,revision,document,canManage}`;
`document` is null or `{filename,size}`. Reads are authenticated and tenant-scoped.
The tenant identity comes exclusively from `getTenantContext`, never from input.
An optional `?tenantId=` must match that context.

* `POST`: `{action:"upload",revision,filename,mimeType:"application/pdf",contentBase64}`.
  Maximum decoded PDF size is 2 MiB; endpoint JSON limit is 3 MiB. Upload/replacement
  **preserves the current mode**. Enabling PDF is an explicit PATCH afterward.
* `PATCH`: `{mode:"standard"|"pdf",revision}`. Standard mode retains the file.
  PDF mode verifies the retained object is readable before the CAS save.
* `DELETE`: `{revision,confirm:true}`. Claims the owned document, removes it from
  private storage, then atomically restores standard mode and clears metadata.
  Failed physical deletion leaves configuration and revision unchanged and keeps
  the previous PDF available through a private recovery copy. The UI must not
  report permanent deletion on an error.
* Document new-tab/preview URL:
  `/api/badge-instructions?document=true&tenantId=ENCODED_CONFIG_TENANT_ID`.
  The tenant pin is mandatory for delivery, since new tabs do not send
  `X-Tenant-Id`. Members can stream the enabled document; admins can also preview
  a retained document in standard mode. Responses are private/no-store, never
  redirect to long-lived signed URLs, and errors provide an HTML standard-help link.

All mutations require `hasAdminAccess`. Generic entity mutations, setting renames,
and browser SQL/storage access cannot bypass the dedicated authority. The database
trigger rejects writes even from generic service-role entity routes.

## Concurrency, quota and recovery

The server-only RPC serializes changes on the tenant row, protects initial singleton
creation and checks the expected revision. Stale operations return 409. Upload
paths use tenant-owned random UUIDs with `upsert:false`; storage paths and deletion
targets are never accepted from clients. A replacement does not detach the old
document until its new private upload has succeeded and CAS commits.

The database reserves tenant storage bytes before upload, enforcing the existing
plan `quotas.storage_mb` limit under the same lock. Replacement temporarily requires
room for both files. Storage bytes are released only after confirmed removal.
The object ledger tracks pending/current/deleting/garbage/cleaned states. Current objects
can never be cleanup targets or acknowledged as deleted. Cleanup acknowledgements
are idempotent and tombstones preserve late-upload recovery.

Deletion uses a durable database claim that blocks competing mutations and retains
the original setting and revision. Before touching storage, the server verifies the
PDF and saves a temporary, service-only base64 recovery copy in the object's private
ledger row (maximum 2 MiB decoded). On a removal error, the claim and backup remain
intact and configuration stays unchanged. Only confirmed physical removal permits
finalizing the standard-mode setting and releasing storage bytes. Finalization clears
the recovery copy. If removal or finalization is interrupted or its response is
ambiguous, the claim and backup remain durable; document delivery can serve the
verified recovery copy, so the previous guidance remains available. Reload settings
and retry confirmed DELETE with the current revision to resume and finish. Other
mutations return 409 while this recovery is pending. Recovery copies are never exposed
through generic entity APIs or direct browser SQL.

No failure handler writes the original storage path back: a simultaneous successful
DELETE retry could otherwise finalize before that write and leave an orphan. Multiple
retries may idempotently remove the same immutable owned path, but only one revision
CAS can finalize. A failed attempt never changes the setting or loses the usable PDF.

Successful upload/replacement/mode changes can include `warning` when **unused
object cleanup** fails: unused objects remain private and their bytes stay reserved
until cleanup succeeds. The UI must show that warning and an actionable retry even
when no document is retained. It must not conflate cleanup warnings with a completed
deletion of a still-configured document. Failed uploads preserve the working object
and report pending cleanup explicitly. An unconfirmed save requires reload before retrying.

Cleanup runs after admin mutations, expires pending uploads older than one hour,
and retries durable garbage rows. Retrying a standard-mode PATCH with the current
revision is sufficient to retry cleanup; it does not delete a retained PDF.
No timer, live cron or deployment is installed by this change. For a tenant with
no subsequent admin mutations, pending/garbage cleanup waits until that retry;
operators may invoke the server-only RPC expiry and the same owned-object cleanup
sequence in a privileged maintenance job after approval. Do not delete current
objects or discard ledger rows. Cleaned tombstones should be retained.

Both `scripts/recompute-tenant-storage.mjs` and the storage-recompute cron
include the private `badge-instructions` bucket. The existing rebaseline
mechanism is not serialized against uploads/reservations; avoid manual
rebaselines while operations are in flight. This pre-existing accounting race
also applies to badge uploads and recovery copies.

## Verification

Run without shared credentials:

    node scripts/run-isolated-tests.mjs --allow-local-postgres node --test api/_lib/badgeInstructions.test.mjs api/_lib/badgeInstructions.postgres.test.mjs

The PostgreSQL suite initializes its own temporary socket-only server and database,
applies the migration twice, exercises real concurrent initial writes, RLS and trigger
bypass rejection, plan quota reservations, stale replacements/deletions, retained
reuse, tenant isolation, idempotent cleanup and expired-upload recovery, then removes
the cluster. It never reads a live database URL.

Before release, verify the two frontend pages together using tenant admin/member
sessions and two tenants, confirm new-tab tenant pinning, PDF default/reuse behavior,
explicit cleanup warnings, and no-store delivery. Signed-in UI verification belongs
to the parent implementation; backend tests do not claim browser verification.
