# WordPress Sync

**Author:** Agent
**Last Updated:** March 2026
**Module:** Content Management / Integrations

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [WordPress Plugin (iConnect Content Sync)](#wordpress-plugin-iconnect-content-sync)
4. [iConnect Public Articles API](#iconnect-public-articles-api)
5. [Webhook Dispatch (iConnect to WordPress)](#webhook-dispatch-iconn-to-wordpress)
6. [Admin Settings UI](#admin-settings-ui)
7. [Sync Engine Logic](#sync-engine-logic)
8. [Shortcode and Block](#shortcode-and-block)
9. [SEO (JSON-LD)](#seo-json-ld)
10. [Database Tables](#database-tables)
11. [Data Flow Diagrams](#data-flow-diagrams)
12. [Configuration Reference](#configuration-reference)
13. [Troubleshooting](#troubleshooting)

---

## Overview

The WordPress Sync integration allows iConnect articles (blog posts) to be automatically published as standard WordPress posts on a tenant's WordPress site. This gives organisations SEO indexing and visitor discovery through their existing WordPress presence, while keeping iConnect as the single source of truth for article content.

The system has two sync directions:

- **WordPress pulls from iConnect** — The WP plugin periodically polls the iConnect public articles API (`/api/public/articles`) and creates/updates/trashes WordPress posts to match. This is the primary sync mechanism and works on any WordPress hosting plan.
- **iConnect pushes to WordPress** (optional) — When articles are created, updated, or deleted in iConnect, a webhook notification is sent to the WordPress site, triggering an immediate sync. This requires a WordPress hosting plan that supports custom REST API routes (WP.com Business plan or higher, or any self-hosted WordPress).

Articles are synced as standard WordPress `post` type (not a custom post type), assigned to a configurable category and author, with tags, featured images, and structured data (JSON-LD) for SEO.

---

## Architecture

### Key Files Table

| File | Purpose |
|------|---------|
| `wordpress-plugin/iconnect-sync/iconnect-sync.php` | Main plugin file, bootstraps all modules |
| `wordpress-plugin/iconnect-sync/includes/class-settings.php` | WP Admin settings page, manual sync button |
| `wordpress-plugin/iconnect-sync/includes/class-sync-engine.php` | Core sync logic: fetches articles, creates/updates/trashes posts |
| `wordpress-plugin/iconnect-sync/includes/class-webhook.php` | REST API endpoint for receiving webhook notifications |
| `wordpress-plugin/iconnect-sync/includes/class-post-type.php` | Manages sync category, legacy migration, admin notices |
| `wordpress-plugin/iconnect-sync/includes/class-shortcode.php` | `[iconnect_articles]` shortcode for displaying synced articles |
| `wordpress-plugin/iconnect-sync/includes/class-block.php` | Gutenberg block wrapper for the shortcode |
| `wordpress-plugin/iconnect-sync/includes/class-seo.php` | JSON-LD structured data output for synced posts |
| `api/public/articles.js` | Public API endpoint serving tenant-scoped published articles |
| `api/admin/wp-sync-settings.js` | Admin API for managing webhook URL and API key settings |
| `api/_lib/wpWebhook.js` | Fire-and-forget webhook dispatch helper |
| `api/entities/[entity]/index.js` | Entity create handler — dispatches webhook on BlogPost create |
| `api/entities/[entity]/[id].js` | Entity update/delete handler — dispatches webhook on BlogPost update/delete |
| `client/src/pages/admin/AdminIntegrations.jsx` | Admin UI for configuring webhook URL and API key |

### Design Principles

1. **iConnect is the single source of truth** — articles are authored and managed in iConnect; WordPress is a read-only mirror.
2. **Polling-first architecture** — the WP cron sync is the primary mechanism, working on any hosting plan without requiring inbound network access.
3. **Webhook as acceleration** — the webhook dispatch is optional and only triggers a full re-sync; it does not send individual article payloads.
4. **Fire-and-forget dispatch** — webhook calls from iConnect are non-blocking and never fail the parent operation (article save/delete).
5. **Standard post type** — synced articles are WordPress `post` type with metadata markers, giving full compatibility with themes, plugins, and SEO tools.

---

## WordPress Plugin (iConnect Content Sync)

### Installation

The plugin is distributed as `iconnect-sync.zip` (built from `wordpress-plugin/iconnect-sync/`). Install via WP Admin > Plugins > Add New > Upload Plugin.

**Version:** 1.1.0

### Requirements

- WordPress 5.0+
- PHP 7.4+
- For webhook support: pretty permalinks must be enabled (requires WP.com Business plan or higher, or self-hosted WordPress)

### What Happens on Activation

1. Default options are set: `iconnect_sync_api_url`, `iconnect_sync_api_key`, `iconnect_sync_frequency`
2. An "iConnect" category is created (or found if it already exists) and stored as `iconnect_sync_category`
3. Legacy posts (from older plugin versions using custom post type `iconnect_article`) are migrated to standard `post` type
4. Plugin version is stored in `iconnect_sync_version`
5. A WP-Cron event is scheduled for periodic syncing

### What Happens on Deactivation

The WP-Cron sync event is cleared. Options and synced posts are **not** deleted (clean uninstall requires deleting the plugin).

### Version Upgrades

On `plugins_loaded`, the plugin compares the stored version against the current version. If the stored version is older, it re-runs category creation and legacy migration, then updates the stored version.

---

## iConnect Public Articles API

### Endpoint

```
GET /api/public/articles
```

**Authentication:** None (public endpoint)
**Tenant Resolution:** Via hostname (e.g., `dev.iconn.app` resolves to the tenant)

### Response Format

```json
{
  "articles": [
    {
      "id": "uuid",
      "title": "Article Title",
      "slug": "article-slug",
      "summary": "Article summary text",
      "feature_image_url": "https://...",
      "feature_image_focal_point": "...",
      "published_date": "2026-01-15T10:00:00Z",
      "author_id": "uuid",
      "guest_writer_id": "uuid",
      "status": "published",
      "subcategories": [...],
      "tags": ["tag1", "tag2"]
    }
  ],
  "authors": {
    "uuid": {
      "name": "First Last",
      "handle": "author-handle",
      "profilePicture": null
    }
  },
  "guestWriters": {
    "uuid": {
      "name": "Guest Name",
      "profilePicture": "https://..."
    }
  }
}
```

**Important:** Only articles with `status = 'published'` are returned, ordered by `published_date` descending.

### How the WP Plugin Uses This

The sync engine constructs the URL as `{iconnect_sync_api_url}/api/public/articles` and passes the iConnect base URL as the `Origin` header for tenant resolution. The response is parsed and each article is mapped to a WordPress post.

---

## Webhook Dispatch (iConnect to WordPress)

### How It Works

When a `BlogPost` entity is created, updated, or deleted in iConnect, the entity handler calls `dispatchWpWebhook()`. This function:

1. Looks up `wp_webhook_url` and `wp_webhook_api_key` from `system_settings` for the tenant
2. If no webhook URL is configured, returns silently
3. Sends a `POST` request to the webhook URL with the event payload
4. The call is fire-and-forget — it does not await the response or block the parent operation

### Webhook Payload

```json
{
  "event": "article.created",
  "article_id": "uuid"
}
```

Events: `article.created`, `article.updated`, `article.deleted`, `test`

### API Key Authentication

If `wp_webhook_api_key` is configured in iConnect, it is sent as the `X-IConnect-API-Key` header. The WordPress plugin validates this against its stored `iconnect_sync_api_key` option. If no API key is set on either side, the webhook is accepted without authentication.

### WordPress Webhook Receiver

**Endpoint:** `POST /wp-json/iconnect-sync/v1/webhook`

Registered by `IConnect_Sync_Webhook` class. On receiving any webhook event, the handler triggers a full sync via `IConnect_Sync_Engine::run_sync()` — it does not process individual article changes from the payload. This keeps the logic simple and ensures consistency.

**Important:** This endpoint requires pretty permalinks to be enabled in WordPress. On WP.com, this means a Business plan or higher. On basic/free plans, custom REST routes are not registered and the endpoint will return a 404.

### Entity Handler Hooks

| Event | File | Location |
|-------|------|----------|
| Article created | `api/entities/[entity]/index.js` | After successful insert, checks if entity is `BlogPost` |
| Article updated | `api/entities/[entity]/[id].js` | After successful update, checks if entity is `BlogPost` |
| Article deleted | `api/entities/[entity]/[id].js` | After successful delete, checks if entity is `BlogPost` |

---

## Admin Settings UI

### iConnect Admin (Webhook Configuration)

**Location:** Admin Integrations page (`/admin/integrations`)
**Component:** `AdminIntegrations.jsx` — WordPress card

The card provides:
- **Webhook URL** text input — the WordPress REST endpoint URL
- **API Key** password input with show/hide toggle — must match the API key set in WordPress plugin settings
- **Save** button — persists both values to `system_settings` via `POST /api/admin/wp-sync-settings`
- **Test Webhook** button — sends a test POST to the webhook URL and displays success/failure with HTTP status
- **Configured badge** — shown when a webhook URL is saved

### WordPress Admin (Plugin Settings)

**Location:** WP Admin > Settings > iConnect Sync

The settings page provides:

| Setting | Description |
|---------|-------------|
| iConnect API URL | Base URL of the iConnect instance (e.g., `https://dev.iconn.app`) |
| API Key | Shared secret for webhook authentication |
| Sync Frequency | How often WP-Cron runs: every 15 min, hourly, twice daily, or daily |
| Sync Category | WordPress category to assign to synced posts (defaults to "iConnect") |
| Post Author | WordPress user to set as author on synced posts (defaults to first admin) |

The page also shows:
- **Sync Now** button for manual immediate sync
- **Sync Status** table (last run time, articles synced/created/updated/trashed, errors)
- **Webhook URL** display showing the endpoint URL for configuring in iConnect

### Admin API Endpoint

**File:** `api/admin/wp-sync-settings.js`

| Method | Purpose |
|--------|---------|
| `GET` | Returns current `webhook_url` and `api_key` for the tenant |
| `POST` | Saves `webhook_url` and `api_key`; if `test: true` is in the body, sends a test webhook instead of saving |

Both methods require an authenticated tenant user session (`tenantUserId` must be present).

---

## Sync Engine Logic

The sync engine (`class-sync-engine.php`) runs on every sync (cron, manual, or webhook-triggered) and performs a full reconciliation:

### Sync Flow

1. Fetch all published articles from `/api/public/articles`
2. Resolve author names from the `authors` and `guestWriters` maps in the response
3. Build the canonical iConnect article URL using the author handle and slug
4. For each article:
   a. Look up existing WordPress post by `_iconnect_id` post meta
   b. If found: update the post title, excerpt, status, and metadata
   c. If not found: create a new post
   d. Set post meta: `_iconnect_synced`, `_iconnect_id`, `_iconnect_author_name`, `_iconnect_published_date`, `_iconnect_slug`, `_iconnect_url`
   e. Assign the sync category
   f. Set tags from the article's `tags` array
   g. Sideload the featured image if the URL has changed
5. Trash any previously synced posts whose iConnect ID is no longer in the response (article was unpublished or deleted)
6. Log the sync status

### Featured Image Handling

The engine sideloads featured images into the WordPress media library using `media_handle_sideload()`. It stores the source URL as `_iconnect_source_url` on the attachment and skips re-downloading if the URL hasn't changed.

### Article URL Construction

```text
If author has a handle:  {base_url}/articles/{author_handle}/{slug}
Otherwise:               {base_url}/articles/{slug}
```

Guest writers use `'guest'` as the handle.

---

## Shortcode and Block

### Shortcode

```
[iconnect_articles limit="6" category="" layout="grid"]
```

| Attribute | Default | Description |
|-----------|---------|-------------|
| `limit` | 6 | Number of articles to display |
| `category` | (empty) | Filter by tag name |
| `layout` | `grid` | Display layout: `grid` or `list` |

Renders article cards with featured image, title, author, date, summary, tags, and a "Read More" link pointing to the iConnect article URL.

### Gutenberg Block

The `iconnect-sync/articles` block wraps the shortcode with the same three attributes (limit, category, layout) and provides a block editor UI with server-side rendering.

---

## SEO (JSON-LD)

For synced posts (`_iconnect_synced = '1'`), the plugin outputs a `<script type="application/ld+json">` block in `wp_head` with Article structured data:

```json
{
  "@context": "https://schema.org",
  "@type": "Article",
  "headline": "Article Title",
  "description": "Plain text excerpt",
  "datePublished": "2026-01-15T10:00:00+00:00",
  "author": {
    "@type": "Person",
    "name": "Author Name"
  },
  "image": "https://...",
  "mainEntityOfPage": {
    "@type": "WebPage",
    "@id": "https://iconnect-url/articles/handle/slug"
  }
}
```

The `mainEntityOfPage` points to the original iConnect article URL (from `_iconnect_url` meta), not the WordPress permalink.

---

## Database Tables

### iConnect: `system_settings` (webhook config)

| Column | Type | Description |
|--------|------|-------------|
| `tenant_id` | UUID | Tenant owning this setting |
| `setting_key` | text | `wp_webhook_url` or `wp_webhook_api_key` |
| `setting_value` | text | The URL or API key value |
| `setting_type` | text | Always `text` |
| `description` | text | Human-readable description |

### iConnect: `blog_post` (source articles)

Key columns used by the public API:

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Article identifier, sent to WP as `_iconnect_id` |
| `tenant_id` | UUID | Tenant scoping |
| `title` | text | Article title |
| `slug` | text | URL-safe slug |
| `summary` | text | Article excerpt/summary |
| `feature_image_url` | text | Featured image URL |
| `published_date` | timestamp | Publication date |
| `author_id` | UUID | FK to `member` |
| `guest_writer_id` | UUID | FK to `guest_writer` |
| `status` | text | Only `published` articles are synced |
| `tags` | text[] | Array of tag strings |

### WordPress: Post Meta (on synced posts)

| Meta Key | Description |
|----------|-------------|
| `_iconnect_synced` | Always `'1'` — marks the post as managed by iConnect |
| `_iconnect_id` | The iConnect article UUID — used to match posts across syncs |
| `_iconnect_author_name` | Resolved author display name |
| `_iconnect_published_date` | Original publication date from iConnect |
| `_iconnect_slug` | Article slug from iConnect |
| `_iconnect_url` | Full URL to the article on the iConnect portal |

### WordPress: Options

| Option | Description |
|--------|-------------|
| `iconnect_sync_api_url` | iConnect base URL |
| `iconnect_sync_api_key` | Shared API key |
| `iconnect_sync_frequency` | Cron frequency |
| `iconnect_sync_category` | Category term ID for synced posts |
| `iconnect_sync_author` | WP user ID for synced posts |
| `iconnect_sync_version` | Installed plugin version |
| `iconnect_sync_last_status` | Last sync result (array with counts and errors) |
| `iconnect_sync_migrated_to_posts` | Flag indicating legacy migration completed |

---

## Data Flow Diagrams

### Periodic Sync (WordPress Pulls)

```
WP-Cron fires (every 15min/hourly/twicedaily/daily)
  -> IConnect_Sync_Engine::run_sync()
    -> GET {iconnect_api_url}/api/public/articles
      -> iConnect resolves tenant from Origin header
      -> Returns published articles + authors + guest writers
    -> For each article:
      -> Find existing WP post by _iconnect_id meta
        -> Found? Update post title/excerpt/meta
        -> Not found? Create new post
      -> Set category, tags, featured image
    -> Trash any synced posts no longer in API response
    -> Log status to iconnect_sync_last_status option
```

### Webhook-Triggered Sync (iConnect Pushes)

```
Admin creates/updates/deletes article in iConnect
  -> Entity handler (index.js or [id].js)
    -> dispatchWpWebhook(tenantId, event, articleId)
      -> Look up wp_webhook_url from system_settings
        -> No URL? Return silently
        -> Has URL? Fire-and-forget POST to webhook
          -> WP receives POST at /wp-json/iconnect-sync/v1/webhook
            -> Validate API key (if configured)
            -> Run full sync (same as cron flow above)
            -> Return sync results
```

### Manual Sync

```
Admin clicks "Sync Now" in WP Admin > Settings > iConnect Sync
  -> AJAX call to wp_ajax_iconnect_sync_now
    -> IConnect_Sync_Engine::run_sync()
    -> Returns counts (created/updated/trashed) to UI
```

### Test Webhook (from iConnect Admin)

```
Admin clicks "Test Webhook" in iConnect Admin Integrations
  -> POST /api/admin/wp-sync-settings { test: true, webhook_url, api_key }
    -> Server sends POST to webhook_url with { event: "test", article_id: null }
    -> Returns { success, status, statusText } to UI
```

---

## Configuration Reference

### iConnect Settings (system_settings table)

| Setting | Location | Values | Default | Description |
|---------|----------|--------|---------|-------------|
| `wp_webhook_url` | Admin > Integrations | Any HTTPS URL | (empty) | WordPress webhook endpoint URL |
| `wp_webhook_api_key` | Admin > Integrations | Any string | (empty) | Shared secret for webhook auth |

### WordPress Plugin Settings

| Setting | Location | Values | Default | Description |
|---------|----------|--------|---------|-------------|
| iConnect API URL | Settings > iConnect Sync | URL | (empty) | Base URL of the iConnect instance |
| API Key | Settings > iConnect Sync | String | (empty) | Shared secret matching iConnect config |
| Sync Frequency | Settings > iConnect Sync | 15min, hourly, twicedaily, daily | hourly | WP-Cron interval |
| Sync Category | Settings > iConnect Sync | Any WP category | "iConnect" (auto-created) | Category assigned to synced posts |
| Post Author | Settings > iConnect Sync | Any WP user with publish_posts | First admin | Author on synced posts |

---

## Troubleshooting

### Problem: Articles not appearing in WordPress
**Symptom:** No posts are created after sync runs
**Cause:** Usually the iConnect API URL is misconfigured or the tenant cannot be resolved
**Fix:** Verify the API URL in WP Settings > iConnect Sync. Visit `{api_url}/api/public/articles` in a browser — it should return JSON with an `articles` array. Check that the URL includes the correct tenant subdomain (e.g., `https://dev.iconn.app`, not `https://iconn.app`).

### Problem: Webhook test returns timeout
**Symptom:** Test webhook shows "The operation was aborted due to timeout" with status 0
**Cause:** The WordPress site cannot be reached from the iConnect server, or the REST API endpoint is not registered
**Fix:** Check that the WordPress site is publicly accessible. Visit the webhook URL in a browser — you should get a REST response (even if it's "Method not allowed" for a GET request). If you see `rest_no_route` 404, the plugin is not registering its routes — see next issue.

### Problem: Webhook URL returns 404 (rest_no_route)
**Symptom:** Visiting the webhook URL in a browser returns `{"code":"rest_no_route","message":"No route was found matching the URL and request method.","data":{"status":404}}`
**Cause:** Pretty permalinks are not enabled. WordPress.com Basic/Free plans do not support custom REST API routes.
**Fix:** Upgrade to WP.com Business plan or use self-hosted WordPress. Then go to Settings > Permalinks and click Save Changes to flush rewrite rules. Verify the plugin is activated.

### Problem: Webhook returns 403 (Invalid API key)
**Symptom:** Test webhook returns HTTP 403
**Cause:** The API key in iConnect does not match the API key in WordPress plugin settings
**Fix:** Ensure the exact same API key string is entered in both iConnect Admin > Integrations (WordPress card) and WP Admin > Settings > iConnect Sync > API Key.

### Problem: Synced posts have no featured image
**Symptom:** Articles sync but featured images are missing
**Cause:** The `feature_image_url` from iConnect may be inaccessible from the WordPress server, or the WordPress media library upload failed
**Fix:** Check that the image URLs in iConnect are publicly accessible. Look for PHP errors in the WordPress error log related to `media_handle_sideload`.

### Problem: Deleted articles still show in WordPress
**Symptom:** Articles removed from iConnect still appear as published posts in WordPress
**Cause:** The sync engine trashes posts whose iConnect IDs are no longer in the API response, but they remain in the WordPress trash
**Fix:** This is expected behaviour. Trashed posts are not visible to site visitors. Empty the WordPress trash if you want to remove them permanently. Confirm a sync has run since the article was deleted — check the sync status in WP Admin.

### Problem: Sync runs but no changes detected
**Symptom:** Sync status shows "0 created, 0 updated, 0 trashed" even though articles have changed
**Cause:** The articles API returns the same data as the last sync — posts are already up to date
**Fix:** This is normal if nothing changed. If you expect changes, verify the article was saved/published in iConnect and the `published_date`, `title`, or `summary` actually differ from what WordPress has.
