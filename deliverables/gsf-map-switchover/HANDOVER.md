# GSF Map Site — Zoho → iConnect Switch-Over (Handover Note)

**Date:** 9 July 2026
**Deliverable:** `class-zoho-api.iconnect.php` — a modified copy of the WordPress plugin's `ZohoAPI` class, repointed from Zoho CRM to iConnect.

## How to review the file

- Every replaced block of the original code is **left in place but commented out**, wrapped in clearly delimited markers:
  ```
  // ==================== ORIGINAL ZOHO CODE (disabled 2026-07-09) ====================
  ...
  // ==================== END ORIGINAL ZOHO CODE ===================================
  ```
- Every new block is tagged `[ICONNECT 2026-07-09]` with a comment explaining the change.
- Method names, signatures and return shapes are **unchanged**, so no other plugin files need to change.
- Everything downstream is untouched: post creation/update, meta fields, stale-record deletion, `getMembers()` filters, and the `gsf_zoho_countries` option shape. Field names and `id` values coming from iConnect are identical to Zoho's.

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

The original file contained a **hard-coded Zoho client id, client secret and refresh token** in plain text (still visible, commented out, at the top of the class so you can identify them). Once the switch-over is confirmed, those credentials should be **rotated / revoked** in the Zoho admin console.

## Validation performed

- `php -l` (PHP 8.1): no syntax errors.
- Automated check: all 1,113 lines of the original file are present in the deliverable, either verbatim (untouched sections) or commented out inside marked blocks — nothing was deleted.
