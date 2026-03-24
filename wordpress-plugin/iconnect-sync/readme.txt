=== iConnect Content Sync ===
Contributors: iconnect
Tags: iconnect, articles, sync, content, seo
Requires at least: 5.8
Tested up to: 6.7
Requires PHP: 7.4
Stable tag: 1.0.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Syncs news articles from an iConnect instance into WordPress as a custom post type for SEO indexing and visitor discovery.

== Description ==

iConnect Content Sync brings your iConnect articles into WordPress automatically. Articles are synced as a dedicated custom post type, making them indexable by search engines while linking readers back to your iConnect platform for the full experience.

**Features:**

* Automatic sync via WP-Cron (every 15 minutes, hourly, twice daily, or daily)
* Manual "Sync Now" from the admin settings page
* Webhook endpoint for instant sync when articles are published in iConnect
* Custom post type with featured images, author info, tags, and publication dates
* `[iconnect_articles]` shortcode for embedding article listings on any page
* Gutenberg block with live editor preview and the same configuration options
* SEO-friendly JSON-LD Article structured data on individual article pages
* Responsive grid and list layouts
* Sync status dashboard showing last run time, counts, and errors

== Installation ==

1. Download the plugin ZIP file.
2. In your WordPress admin, go to Plugins > Add New > Upload Plugin.
3. Upload the ZIP file and click "Install Now".
4. Activate the plugin.
5. Go to Settings > iConnect Sync.
6. Enter your iConnect instance URL (e.g., `https://your-tenant.iconn.app`).
7. Optionally enter an API key for webhook validation.
8. Choose your preferred sync frequency.
9. Click "Sync Now" to pull in your first batch of articles.

== Configuration ==

**Settings Page (Settings > iConnect Sync)**

* **iConnect API URL** — The base URL of your iConnect instance.
* **API Key** — Used for webhook request validation. Set this to match the key configured in your iConnect instance.
* **Sync Frequency** — How often WP-Cron checks for new or updated articles.

**Shortcode Usage**

Display articles on any page or post:

`[iconnect_articles]`

Available attributes:

* `limit` — Number of articles to display (default: 6)
* `category` — Filter by tag name
* `layout` — Display layout: `grid` or `list` (default: grid)

Examples:
`[iconnect_articles limit="3" layout="list"]`
`[iconnect_articles category="Technology" limit="9"]`

**Gutenberg Block**

Search for "iConnect Articles" in the block inserter. Configure the same options (limit, tag filter, layout) in the block's sidebar panel.

**Webhook**

Configure iConnect to send POST requests to your webhook URL (shown on the settings page) whenever articles are published or updated. Include the API key as an `X-IConnect-API-Key` header.

== Frequently Asked Questions ==

= Does this plugin display full article content? =

No. The plugin syncs the article title, summary, featured image, author, tags, and publication date. A "Read More" link directs visitors to the full article on your iConnect site.

= Can I edit synced articles in WordPress? =

Synced articles are read-only in WordPress. Content is managed in iConnect and synced automatically.

= What happens when an article is removed from iConnect? =

During the next sync, any articles that no longer appear in the iConnect feed are automatically moved to the WordPress trash.

= Does it work with any WordPress theme? =

Yes. The shortcode and block output clean, semantic HTML with scoped CSS that adapts to your theme's fonts and colors.

= How do I trigger an immediate sync? =

Either click "Sync Now" on the settings page, or configure iConnect to call the webhook endpoint.

== Changelog ==

= 1.0.0 =
* Initial release
* Article sync from iConnect public API
* Custom post type with metadata
* WP-Cron scheduling with configurable frequency
* Webhook endpoint for instant sync
* Shortcode with grid/list layouts and tag filtering
* Gutenberg block with server-side rendering
* JSON-LD Article structured data for SEO
