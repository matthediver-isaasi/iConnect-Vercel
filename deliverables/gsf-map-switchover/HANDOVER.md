# GSF Map Site — Zoho → iConnect Switch-Over (Handover Note)

**Date:** 26 August 2026
**Deliverables:** `class-zoho-api.iconnect.php` — a modified copy of the
WordPress plugin's `ZohoAPI` class, repointed from Zoho CRM to iConnect; and
`stats.iconnect.php` — the companion replacement for the theme's member map
statistics file.
**Integration version:** `3.1.0`
**Map stats version:** `1.1.0`

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

## LMIC country compatibility refresh — 26 August 2026

The iConnect feed supplies the individual, tenant-selected LMIC countries in
the `Countries_of_Operation` array rather than storing the display summary
“Multiple locations” as data. The existing WordPress front end remains
unchanged: one applicable country displays its name; two or more display
“Multiple Locations” and use the array as the hover tooltip. This package
includes a WordPress-side one-time refresh so existing member posts are
corrected immediately after installation instead of waiting for the normal
hourly sync:

1. install this package's `class-zoho-api.iconnect.php`;
2. open **Settings → GSF iConnect Feed** and confirm **Integration version
   3.1.0** is displayed;
3. select **Refresh country data and members**;
4. require the page to report that the country cache was refreshed and
   reapplied to the expected number of member records;
5. confirm Justice Rising returns Congo, Dem. Rep., Iraq, and Syria in
   `Countries_of_Operation`;
6. confirm its card still displays “Multiple Locations” and the existing hover
   tooltip lists those three countries.

For the Aptus staging check, the completed refresh should rewrite its tooltip
source to Dominican Republic, Ecuador, Mexico, and Chile when those are the
countries returned by both configured iConnect feeds. Uruguay must not remain
when it is absent from the GSF tenant's saved LMIC selection.

Both iConnect map endpoints now derive their country data from the same
tenant-LMIC-filtered collection. Unresolvable and non-selected countries are
excluded; the country feed emits `Flag: Show` only after a country has resolved
and matched the tenant list. The refresh version is recorded only after a
successful country and member sync. Failed or busy attempts remain eligible to
retry. The public member response also strips any stale “Multiple locations”
sentinel while the refresh is in flight, and country filtering continues to use
the individual-country metadata.

### Map shading uses the same selected-country list

Install `stats.iconnect.php` over:

```text
wp-content/themes/global-schools-forum/core/members/stats.php
```

The installed file declares `GSF_MAP_STATS_VERSION` as `1.1.0`; inspect that
constant in the deployed theme file to distinguish this correction from the
original stats implementation.

The previous stats implementation rebuilt LMIC eligibility from three legacy
`income_group` labels. That excluded Chile from `get_map_data` even though the
tenant-selected Countries feed marked it `Flag: Show` and the Aptus tooltip
already included it. The replacement treats the cached country record's
case-insensitive `Flag: Show` as authoritative, matching member ingestion and
tooltip filtering. Existing country normalization and map display aliases are
unchanged.

After replacing the theme file, reload Our Community and inspect
`admin-ajax.php?action=get_map_data`: `data.countryCounts.Chile` must be a
positive integer. Aptus should still list Dominican Republic, Ecuador, Mexico,
and Chile, and Chile should be shaded. The AJAX map response itself is not
transient-cached; the existing member sync already clears the separate
`gsf_community_stats` text-placeholder transient.

The ZIP is built from the checked-in files with:

```bash
./deliverables/gsf-map-switchover/build-package.sh
```

The build verifies every archived file byte-for-byte against its source before
replacing the distributable, preventing a reviewed class change from being
omitted from the installable package.

## WordPress configuration (set BEFORE deploying)

Two new WP options — no secrets are hard-coded in the file:

Administrators without WP-CLI can use **Settings → GSF iConnect Feed** in
WordPress Admin. Enter the live iConnect HTTPS origin, enter the shared secret,
and choose **Save and test connection**. The stored API key is write-only and is
never rendered back into the settings page.

The same page displays the installed integration version and provides
**Refresh country data and members**. This administrator-only, nonce-protected
action bypasses the normal 24-hour country interval, fetches the configured
`/api/public/gsf-map/countries` endpoint, and then reapplies that country
allow-list to all member metadata in the same locked sync. Do not delete
`gsf_zoho_countries` or the sync-lock option manually. If the page reports
`member_sync_already_running`, wait for the current run to finish and retry. For
other failures, inspect the GSF sync log for **Fetching countries from
iConnect**, correct the named endpoint, API-key, network, or payload issue, and
retry; failed country loads retain the last-known-good cache.

The equivalent WP-CLI commands are:

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

- `php -l` (PHP 8.2): no syntax errors in the class, theme stats replacement,
  inventory, cleanup, or tests.
- Behavioral PHP checks cover all-status identity matching, published-first
  canonical selection, status preservation, pre-existing duplicates, old
  noncanonical `last_sync`, global sync timestamps, option and MySQL advisory
  lock contention, named findings, cleanup dry-run immutability, staged
  per-deletion mutation fencing, final-survivor snapshot matching, persistent
  journal fallback, one-time country-data refresh, stale summary replacement,
  public multi-country tooltip source and filtering, the observed
  237-published/232-identity starting state,
  mixed candidate statuses, explicit feed-failure handling, and the temporary
  browser cleanup's administrator/POST/nonce/confirmation and one-time-plan
   controls. The stats checks cover authoritative `Flag: Show` eligibility,
   Chile with a High Income label, hidden legacy-income countries, and existing
   frontend display aliases.

Run them from this repository:

```bash
php deliverables/gsf-map-switchover/tests/class-zoho-api-dedup.test.php
php deliverables/gsf-map-switchover/tests/stats-iconnect.test.php
php deliverables/gsf-map-switchover/tests/wp-gsf-map-reconcile.test.php
php deliverables/gsf-map-switchover/tests/wp-gsf-map-cleanup.test.php
php deliverables/gsf-map-switchover/tests/wp-gsf-map-cleanup.test.php apply
php deliverables/gsf-map-switchover/tests/class-zoho-api-browser-cleanup.test.php
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
upsert runs under a layered lock: a connection-owned MySQL advisory lock plus
the token-fenced WordPress option lease `gsf_iconnect_member_sync_lock`. The
advisory lock serializes live database connections; initial option-lease
acquisition uses the unique option key, expired takeover and renewal use
database compare-and-swap, and release uses compare-and-delete. The option lease
expires after 15 minutes, renews between fetch, cleanup, and each member write,
and prevents an old request from overwriting or releasing a replacement owner.
An overlapping request returns:

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
current feed ID. The distributable PHP class now temporarily includes a
browser-only cleanup for an administrator who does not have WP-CLI access.
The existing `wp-gsf-map-reconcile.php` and `wp-gsf-map-cleanup.php` procedures
remain supported alternatives. Both routes are limited to the five reviewed
identities, require a dry run, validate exact feed and WordPress post IDs against
live state, and take the same layered sync lock before apply.

`delete` permanently removes only the approved noncanonical IDs. `trash`
archives them, but an all-status reconciliation will continue to report them as
duplicates. To meet the strict zero-duplicate final gate, preserve the before
inventory as evidence and use the explicitly reviewed `delete` action.

### Temporary browser cleanup: install, run, and remove

1. Back up the PHP class file currently installed on WordPress. Install this
   deliverable by replacing that **same plugin PHP class file** with
   `class-zoho-api.iconnect.php`; do not add it as a second plugin file. Sign in
   as an administrator and open **Members > Duplicate Cleanup**.
2. Review the live all-status inventory. Do not continue unless the configured
   feed is exactly 232 raw rows/232 unique nonblank IDs and the pre-cleanup
    WordPress state is exactly 237 all-status posts representing 232 unique
    stable identities, with 232 unique published identities and only the five
    reviewed duplicate pairs. The raw published-post count may be 232–237:
    the reviewed live state has all 237 posts published, because each of the five
    reviewed candidates is published as well as its deterministic survivor.
    Candidate status does not weaken the exact post-ID fence. Every displayed
    pre-cleanup safety gate must pass.
3. Select **Generate fresh dry run**. This mandatory non-mutating step captures
   the before report and creates a one-time, user-bound exact-ID plan. Download
   or copy both **Before report** and **Dry-run deletion plan** JSON before
    applying. Review every published survivor and noncanonical deletion ID,
    including the captured status of each candidate, and take a verified
    pre-apply WordPress database backup.
4. For apply, tick the acknowledgement and type the exact case-sensitive phrase
   `DELETE REVIEWED DUPLICATES`. Apply permanently deletes, one at a time, only
   the five exact noncanonical post IDs in the plan. Before **each** deletion it
   rebuilds and compares the exact staged feed/WordPress identity snapshot,
   checks the published survivor, then verifies that it still owns both the
   advisory and option locks immediately before `wp_delete_post`; it also checks
   that WordPress actually removed the post. The final report must match the
   expected survivor identity snapshot as well as the strict gates. The
   one-time plan is consumed on the first apply attempt.
5. Download or copy the **Apply log** and **After report** JSON immediately.
   Require every after gate to pass: 232 feed rows/232 unique IDs, 232
    all-status WordPress posts, exactly 232 raw published posts representing 232
    unique published WordPress identities, and zero duplicate, blank, stale,
    orphan, or missing stable IDs; the expected final survivor snapshot must
    match the actual final snapshot.

If the configured feed cannot be trusted, the page now shows a prominent
**Configured iConnect feed reconciliation is unavailable** notice with the
endpoint or missing-option source and the concrete error. Missing
`gsf_iconnect_base_url` / `gsf_iconnect_api_key`, HTTP 401, HTTP 503, other HTTP
errors, WordPress/network errors, malformed JSON, and non-array payloads all
block dry run and apply. Feed-dependent stale/orphan/missing results display as
**UNAVAILABLE**, not as findings calculated from an empty feed. Preserve the
notice or JSON evidence and correct the named configuration, credential,
endpoint, deployment-secret, network, or payload problem outside this cleanup
tool; then reload and generate a fresh dry run. Do not infer that a failed feed
means zero current members.

The page and normal sync share the connection-owned MySQL advisory lock and the
token-fenced 15-minute `gsf_iconnect_member_sync_lock` option lease. If the page
reports that sync/cleanup is already running, do not delete the option or bypass
either lock: wait for the legitimate process to finish, reload the live
inventory, and generate a fresh dry run before retrying. Because apply consumes
its one-time ticket even when later blocked, any failed apply also requires a
fresh dry run.

If apply was blocked before any deletion, retain the JSON/error, resolve the
lock, changed-live-state, permission, or feed problem, then start again from a
fresh inventory and dry run. If the apply log shows only some deletions, stop:
do not run a normal sync, recreate posts by hand, or retry a stale plan. Capture
the apply/after JSON and recover the WordPress database from the pre-apply
backup so the exact reviewed 237-post state is restored; verify it with a fresh
inventory: 237 published posts representing 232 stable identities, with only
the five reviewed pairs. Then repeat dry run and apply. Escalate instead of
proceeding if that state cannot be restored. A crashed request releases its connection-owned MySQL
advisory lock, but this is not evidence that no deletion occurred: inspect the
per-user journal and apply evidence first, then restore the backup for any
partial cleanup before retrying.

This interface's downloadable browser evidence is transient-backed for 24
hours. In addition, each pending deletion, result, and error is appended as
recovery evidence to the non-expiring per-user WordPress option
`gsf_cleanup_journal_<user-id>`; if the transient has expired, the Apply/After
downloads use that journal as a fallback. After all four JSON artifacts and the
journal evidence have been saved and the strict 232/232 result independently
verified, remove it by replacing the deployed PHP class file with a copy that
removes the temporary
`GSF_Reviewed_Duplicate_Cleanup_Admin` class **and** its registration block.
Do not change the `ZohoAPI` sync implementation or its normal result wording
when preparing that cleanup-free copy.

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
