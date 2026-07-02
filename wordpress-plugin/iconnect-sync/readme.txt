=== iConnect Content Sync ===
Contributors: iconnect
Tags: iconnect, articles, sync, content, seo
Requires at least: 5.8
Tested up to: 6.7
Requires PHP: 7.4
Stable tag: 1.1.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Syncs news articles from an iConnect instance into WordPress as standard posts for SEO indexing and visitor discovery.

== Description ==

iConnect Content Sync brings your iConnect articles into WordPress automatically. Articles are synced as standard WordPress posts, so they appear alongside your existing blog content using your theme's layout and styles. They are indexed by search engines and link readers back to your iConnect platform for the full experience.

**Features:**

* Articles sync as standard WordPress posts — they appear in your existing blog/news pages automatically
* Configurable WordPress category for synced posts (default: "iConnect")
* Configurable post author for synced articles
* Tags from iConnect map to standard WordPress tags
* Automatic sync via WP-Cron (every 15 minutes, hourly, twice daily, or daily)
* Manual "Sync Now" from the admin settings page
* Webhook endpoint for instant sync when articles are published in iConnect
* Featured images, author info, tags, and publication dates
* `[iconnect_articles]` shortcode for embedding article listings on any page
* Gutenberg block with live editor preview and the same configuration options
* SEO-friendly JSON-LD Article structured data on synced article pages
* Responsive grid and list layouts
* Sync status dashboard showing last run time, counts, and errors
* Admin notice on synced posts warning that content is managed by iConnect

== Installation ==

1. Download the plugin ZIP file.
2. In your WordPress admin, go to Plugins > Add New > Upload Plugin.
3. Upload the ZIP file and click "Install Now".
4. Activate the plugin.
5. Go to Settings > iConnect Sync.
6. Enter your iConnect instance URL (e.g., `https://your-tenant.iconn.app`).
7. Optionally enter an API key for webhook validation.
8. Choose your preferred sync frequency.
9. Select which WordPress category synced articles should be assigned to (an "iConnect" category is created automatically).
10. Select which WordPress user should be set as the author on synced posts.
11. Click "Sync Now" to pull in your first batch of articles.

== Configuration ==

**Settings Page (Settings > iConnect Sync)**

* **iConnect API URL** — The base URL of your iConnect instance.
* **API Key** — Used for webhook request validation. Set this to match the key configured in your iConnect instance.
* **Sync Frequency** — How often WP-Cron checks for new or updated articles.
* **Sync Category** — The WordPress category assigned to synced articles. Useful for including or excluding iConnect articles from specific page templates.
* **Post Author** — The WordPress user set as author on synced posts. Defaults to the site's first administrator.

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

= Will synced articles appear on my existing blog/news page? =

Yes. Synced articles are standard WordPress posts, so they appear alongside your existing content in blog pages, archives, category listings, and search results using your theme's layout.

= Can I edit synced articles in WordPress? =

While the editor is not locked, a notice warns that the post is managed by iConnect. Any manual edits will be overwritten on the next sync.

= What happens when an article is removed from iConnect? =

During the next sync, any articles that no longer appear in the iConnect feed are automatically moved to the WordPress trash.

= Does it work with any WordPress theme? =

Yes. Synced articles are standard posts, so they inherit your theme's styles and templates. The shortcode and block also output clean, semantic HTML with scoped CSS.

= How do I trigger an immediate sync? =

Either click "Sync Now" on the settings page, or configure iConnect to call the webhook endpoint.

= I'm upgrading from version 1.0 — what happens to my existing articles? =

The plugin automatically migrates existing iConnect articles from the old custom post type to standard WordPress posts. Tags are remapped to standard WordPress tags. No data is lost.

== Upgrade Notice ==

= 1.1.0 =
Articles now sync as standard WordPress posts instead of a custom post type. Existing articles are migrated automatically. They will appear in your blog alongside other posts.

== Changelog ==

= 1.1.0 =
* Articles now sync as standard WordPress posts instead of a custom post type
* Automatic migration of existing iConnect articles to standard posts on upgrade
* Tags now map to standard WordPress tags (post_tag)
* New "Sync Category" setting to assign synced articles to a WordPress category
* New "Post Author" setting to choose which WordPress user authors synced posts
* Admin notice on synced posts warning that content is managed by iConnect
* Removed custom post type (iconnect_article) and custom taxonomy (iconnect_tag)

= 1.0.0 =
* Initial release
* Article sync from iConnect public API
* Custom post type with metadata
* WP-Cron scheduling with configurable frequency
* Webhook endpoint for instant sync
* Shortcode with grid/list layouts and tag filtering
* Gutenberg block with server-side rendering
* JSON-LD Article structured data for SEO
