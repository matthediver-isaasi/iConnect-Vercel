# GSF Map Site — Zoho → iConnect Switch-Over (Handover Note)

**Date:** 25 August 2026
**Deliverable:** `class-zoho-api.iconnect.php` — a modified copy of the WordPress plugin's `ZohoAPI` class, repointed from Zoho CRM to iConnect.

## How to review the file

- Every replaced block of the original code is **left in place but commented out**, wrapped in clearly delimited markers:
  ```
  // ==================== ORIGINAL ZOHO CODE (disabled 2026-07-09) ====================
  ...
  // ==================== END ORIGINAL ZOHO CODE ===================================
  ```
- Every new block is tagged `[ICONNECT 2026-07-09]` with a comment explaining the change.
- Public method signatures remain compatible. `getMembers()` keeps its existing
  fields and adds `sync_result`; private sync helpers now return structured
  status internally so busy/failed runs are distinguishable.
- Feed field names, `id` values, `getMembers()` filters, and the
  `gsf_zoho_countries` option shape remain compatible. The member upsert and
  sync orchestration were intentionally hardened on 25 August 2026 as described
  below.

## The two new endpoints

| Data | Endpoint |
| --- | --- |
| Members | `GET {base}/api/public/gsf-map/members` |
| Countries | `GET {base}/api/public/gsf-map/countries` |

- **Auth:** shared secret sent as an `X-Api-Key` header.
- Both return a **bare JSON array** in a single response — no pagination, no Zoho-style `data` / `info.more_records` envelope.
- The members payload is already filtered to **current members** of the two member account types (the old Zoho `criteria` search now happens server-side in iConnect).
- Country rows have the exact Zoho `Countries1` shape (`Country.name`, `Country.id`, `Income_Group`, `GSF_Region_Classification`, `Flag`), so the plugin's per-row mapping is preserved verbatim.

## WordPress configuration (set BEFORE deploying)

Two new WP options — no secrets are hard-coded in the file:

```
wp option update gsf_iconnect_base_url 'https://<iconnect-host>'   # no trailing slash
wp option update gsf_iconnect_api_key  '<shared secret>'
```

If either option is missing, the sync logs an ERROR and aborts (there is no fallback to Zoho).

## iConnect-side prerequisites

- The env var **`GSF_MAP_API_SECRET`** must be set on the iConnect deployment. Until it is, both endpoints return **HTTP 503** ("GSF map API not configured"). The value of that env var is what goes into the `gsf_iconnect_api_key` WP option.
- Responses are **CDN-cached for 5 minutes** (`Cache-Control: max-age=300, stale-while-revalidate=600`), so data changes in iConnect can take up to ~5 minutes to appear in a WordPress sync.

## Error handling changes

- **401** now means the API key is wrong or rotated. Unlike Zoho, there is no token to refresh or clear — the code logs an ERROR and aborts. (The old behaviour of deleting cached Zoho tokens on 401 is commented out.)
- **503** is logged as "GSF_MAP_API_SECRET not set on iConnect".
- All Zoho OAuth machinery (`maybeRefreshToken()`, hard-coded credentials, token option reads/writes) is commented out / no-opped.

## Debug path

`testGetZohoData()` has been repointed at the two iConnect endpoints, so the plugin's debug tooling no longer hits Zoho. Its return shape is kept compatible (it emulates the old paged Zoho envelope by slicing the requested page out of the full member list).

The legacy debug helpers `clearCachedTokens()` / `getTokenStatus()` are kept as-is (harmless). Running `clearCachedTokens()` once after the switch-over will clean the stale Zoho tokens out of `wp_options`.

## Security — please action

The original file contained a **hard-coded Zoho client id, client secret and
refresh token** in plain text. Their literal values have been removed from this
distributable. Earlier exposure cannot be undone by deletion, so those
credentials must still be **rotated / revoked** in the Zoho admin console.

## Validation performed

- `php -l` (PHP 8.2): no syntax errors in the class, inventory, cleanup, or tests.
- Behavioral PHP checks cover all-status identity matching, published-first
  canonical selection, status preservation, pre-existing duplicates, old
  noncanonical `last_sync`, global sync timestamps, lock contention, named
  findings, and cleanup dry-run immutability.

Run them from this repository:

```bash
php deliverables/gsf-map-switchover/tests/class-zoho-api-dedup.test.php
php deliverables/gsf-map-switchover/tests/wp-gsf-map-reconcile.test.php
php deliverables/gsf-map-switchover/tests/wp-gsf-map-cleanup.test.php
php deliverables/gsf-map-switchover/tests/wp-gsf-map-cleanup.test.php apply
```

## Deduplication hardening — 25 August 2026

### Complete identity matching

Member lookup now includes every registered WordPress post status and retrieves
all matches for a stable feed ID. The canonical post is deterministic:

1. prefer a published post;
2. otherwise use the lowest WordPress post ID.

Only that post is updated. Its existing status is preserved, so a private,
pending, future, trashed, custom-status, or draft post is not silently
published. Every extra match is logged and included in `gsf_last_sync_stats`
with post ID, status, timestamps, and per-record `last_sync`.

### Serialized syncs

The complete country/member fetch, published stale/orphan cleanup, and member
upsert runs under the WordPress option lease
`gsf_iconnect_member_sync_lock`. Initial acquisition uses the unique option key;
expired takeover and renewal use database compare-and-swap, and release uses
compare-and-delete. The lease expires after 15 minutes, renews between fetch,
cleanup, and each member write, and is token-fenced so an old request cannot
overwrite or release a replacement owner. An overlapping request returns:

```json
{
  "status": "busy",
  "reason": "member_sync_already_running"
}
```

The structured value is exposed as `sync_result` by `getMembers()` and stored in
`gsf_last_sync_result`; legacy `deleted_count` and `sync_stats` fields remain.

### Cleanup is separate and reviewed

Normal sync reports duplicates but never silently removes an extra post with a
current feed ID. Use `wp-gsf-map-cleanup.php` only after capturing and reviewing
the all-status inventory. Cleanup accepts exact feed IDs and WordPress post IDs,
is limited to the five reviewed identities, defaults to dry-run, validates that
the live post set has not changed, and takes the same sync lock before apply.

`delete` permanently removes only the approved noncanonical IDs. `trash`
archives them, but an all-status reconciliation will continue to report them as
duplicates. To meet the strict zero-duplicate final gate, preserve the before
inventory as evidence and use the explicitly reviewed `delete` action.

## Member-count reconciliation

The reconciliation package lives beside this handover:

- `RECONCILIATION-2026-08-24.md` — original investigation plus the hardened
  25 August operator procedure.
- `wp-gsf-map-reconcile.php` — an all-status WordPress inventory for WP-CLI.
- `wp-gsf-map-cleanup.php` — exact-ID, dry-run-first cleanup for the five
  reviewed identities.
- `../../scripts/reconcile-gsf-map.mjs` — dashboard/feed/WordPress comparator.

Run the WordPress inventory from the WordPress root:

```bash
wp eval-file /path/to/wp-gsf-map-reconcile.php \
  > /tmp/gsf-wordpress-inventory.json
```

It only reads the configured iConnect feed and `gsf_member` posts across every
registered post status. It does not create, update, publish, draft, trash, or
delete anything. The export includes the exact configured feed ID/name snapshot,
global sync time, each post's creation/modification/per-record sync dates,
deterministic canonical/noncanonical records, five named findings, exact-ID plan
examples, and strict 232/232 acceptance booleans.

Then compare it from this repository:

```bash
node scripts/reconcile-gsf-map.mjs \
  --wordpress-inventory=/tmp/gsf-wordpress-inventory.json \
  --format=markdown
```

Avoid using the site's public `search_members` AJAX action as an audit probe:
that route calls `getMembers()`, which may start a normal sync when its interval
has elapsed. The public REST inventory used by the Node diagnostic is
publish-only but does not trigger the plugin's sync path.

Follow the full before → dry-run → explicit apply → after procedure in
`RECONCILIATION-2026-08-24.md`. Keep both JSON inventories and the reviewed plan
with the deployment record.
