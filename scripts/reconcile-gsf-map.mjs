#!/usr/bin/env node
/**
 * Read-only GSF map reconciliation.
 *
 * Compares:
 *   1. the "Total GSF Members" dashboard population,
 *   2. the locally-built or deployed iConnect members feed, and
 *   3. WordPress gsf_member posts from either the public REST API (publish
 *      only) or the output of wp-gsf-map-reconcile.php (all statuses).
 *
 * No command in this script writes to iConnect or WordPress.
 *
 * Usage:
 *   node scripts/reconcile-gsf-map.mjs
 *   node scripts/reconcile-gsf-map.mjs \
 *     --wordpress-url=https://www.globalschoolsforum.org
 *   GSF_MAP_API_SECRET=... node scripts/reconcile-gsf-map.mjs \
 *     --api-base=https://iconnect.example \
 *     --wordpress-inventory=/tmp/gsf-wordpress-inventory.json \
 *     --include-records --format=markdown
 *
 * Generate the all-status WordPress inventory on the WordPress host:
 *   wp eval-file /path/to/wp-gsf-map-reconcile.php > /tmp/gsf-wordpress-inventory.json
 */
import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import {
  GSF_MAP_FIELD_IDS,
  buildMembersPayload,
  loadGsfMapData,
} from '../api/_lib/gsfMapPayload.js';

const GSF_TENANT_ID = '21296ad6-1350-483a-a90c-1b06ece70501';
const TOTAL_GSF_MEMBERS_WIDGET_ID = '42bb5856-4982-4dd0-8995-21d55bf49e95';

const args = Object.fromEntries(
  process.argv.slice(2).filter((arg) => arg.startsWith('--')).map((arg) => {
    const [key, ...rest] = arg.slice(2).split('=');
    return [key, rest.length ? rest.join('=') : true];
  }),
);

const wordpressUrl = typeof args['wordpress-url'] === 'string'
  ? args['wordpress-url'].replace(/\/+$/, '')
  : null;
const wordpressInventoryPath = typeof args['wordpress-inventory'] === 'string'
  ? args['wordpress-inventory']
  : null;
const apiBase = typeof args['api-base'] === 'string'
  ? args['api-base'].replace(/\/+$/, '')
  : null;
const includeRecords = args['include-records'] === true;
const format = args.format === 'markdown' ? 'markdown' : 'json';

const stringId = (value) => String(value ?? '').trim();
const titleText = (value) => {
  if (typeof value === 'string') return value;
  return typeof value?.rendered === 'string' ? value.rendered : '';
};

function groupById(rows, getId) {
  const grouped = new Map();
  for (const row of rows) {
    const id = stringId(getId(row));
    const list = grouped.get(id) || [];
    list.push(row);
    grouped.set(id, list);
  }
  return grouped;
}

function duplicateGroups(rows, getId, describe) {
  return [...groupById(rows, getId)]
    .filter(([id, matches]) => id && matches.length > 1)
    .map(([feed_id, matches]) => ({
      feed_id,
      records: matches.map(describe),
    }));
}

function compareFeedIdentitySets(currentFeed, capturedFeed, capturedSource) {
  const currentIds = new Set(currentFeed.map((row) => stringId(row.id)).filter(Boolean));
  const capturedIds = new Set(capturedFeed.map((row) => stringId(row.id)).filter(Boolean));
  const currentBlankIds = currentFeed.filter((row) => !stringId(row.id));
  const capturedBlankIds = capturedFeed.filter((row) => !stringId(row.id));
  const currentDuplicates = duplicateGroups(
    currentFeed,
    (row) => row.id,
    (row) => ({ name: row.Account_Name || '' }),
  );
  const capturedDuplicates = duplicateGroups(
    capturedFeed,
    (row) => row.id,
    (row) => ({ name: row.Account_Name || '' }),
  );
  const captured_ids_missing_from_endpoint = [...capturedIds]
    .filter((id) => !currentIds.has(id));
  const endpoint_ids_missing_from_capture = [...currentIds]
    .filter((id) => !capturedIds.has(id));
  return {
    captured_source: capturedSource,
    captured_raw_records: capturedFeed.length,
    captured_unique_nonblank_ids: capturedIds.size,
    captured_blank_ids: capturedBlankIds.length,
    captured_duplicate_ids: capturedDuplicates,
    endpoint_raw_records: currentFeed.length,
    endpoint_unique_nonblank_ids: currentIds.size,
    endpoint_blank_ids: currentBlankIds.length,
    endpoint_duplicate_ids: currentDuplicates,
    captured_ids_missing_from_endpoint,
    endpoint_ids_missing_from_capture,
    exact_id_set_match:
      currentBlankIds.length === 0
      && capturedBlankIds.length === 0
      && currentDuplicates.length === 0
      && capturedDuplicates.length === 0
      && currentFeed.length === capturedFeed.length
      && capturedFeed.length === capturedIds.size
      && captured_ids_missing_from_endpoint.length === 0
      && endpoint_ids_missing_from_capture.length === 0,
  };
}

async function loadDashboardWidget() {
  const url = process.env.DEST_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.DEST_SUPABASE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Supabase not configured for dashboard widget lookup');
  const client = createClient(url, key, { auth: { persistSession: false } });
  const { data, error } = await client
    .from('dashboard_widget')
    .select('id, title, scope, config, updated_at')
    .eq('tenant_id', GSF_TENANT_ID)
    .eq('id', TOTAL_GSF_MEMBERS_WIDGET_ID)
    .maybeSingle();
  if (error) throw new Error(`Failed loading Total GSF Members widget: ${error.message}`);
  if (!data) throw new Error(`Total GSF Members widget ${TOTAL_GSF_MEMBERS_WIDGET_ID} was not found`);
  if (data.title !== 'Total GSF Members') {
    throw new Error(`Widget ${TOTAL_GSF_MEMBERS_WIDGET_ID} is now titled "${data.title}"`);
  }
  if (data.config?.source !== 'organization' || data.config?.measure?.aggregator !== 'count') {
    throw new Error('Total GSF Members widget is no longer an organization count');
  }
  return data;
}

function matchesDashboardFilter(org, prefs, filter) {
  let actual;
  if (filter?.fieldKind === 'custom' && filter.fieldId) {
    actual = prefs[filter.fieldId];
  } else if (filter?.fieldKind === 'core' && filter.field) {
    actual = org[filter.field];
  } else {
    throw new Error(`Unsupported dashboard filter field: ${JSON.stringify(filter)}`);
  }
  const operator = String(filter.operator || '').toLowerCase();
  if (operator === 'eq') return String(actual ?? '') === String(filter.value ?? '');
  if (operator === 'in' && Array.isArray(filter.value)) {
    return filter.value.map(String).includes(String(actual ?? ''));
  }
  throw new Error(`Unsupported dashboard filter operator: ${filter.operator}`);
}

function dashboardFilterLabel(filter) {
  const field = filter.fieldKind === 'custom'
    ? `custom:${filter.fieldId}`
    : `core:${filter.field}`;
  const value = Array.isArray(filter.value) ? `[${filter.value.join(', ')}]` : String(filter.value ?? '');
  return `${field} ${filter.operator} ${value}`;
}

async function fetchMembersEndpoint() {
  const token = process.env.GSF_MAP_API_SECRET;
  if (!token) {
    throw new Error('--api-base requires GSF_MAP_API_SECRET in the environment');
  }
  const response = await fetch(`${apiBase}/api/public/gsf-map/members`, {
    headers: { 'X-Api-Key': token, Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`GSF members endpoint returned HTTP ${response.status}`);
  }
  const payload = await response.json();
  if (!Array.isArray(payload)) throw new Error('GSF members endpoint did not return an array');
  return payload;
}

async function fetchPublishedWordpressPosts() {
  const records = [];
  for (let page = 1; ; page += 1) {
    const url = new URL(`${wordpressUrl}/wp-json/wp/v2/gsf_member`);
    url.searchParams.set('per_page', '100');
    url.searchParams.set('page', String(page));
    url.searchParams.set('_fields', 'id,status,slug,title,meta');
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`WordPress REST inventory returned HTTP ${response.status} on page ${page}`);
    }
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error('WordPress REST inventory did not return an array');
    records.push(...rows.map((row) => ({
      wp_post_id: row.id,
      status: row.status,
      slug: row.slug,
      name: titleText(row.title),
      feed_id: stringId(row.meta?.zoho_id),
    })));
    const totalPages = Number(response.headers.get('x-wp-totalpages') || 1);
    if (page >= totalPages) break;
  }
  return {
    source: `${wordpressUrl}/wp-json/wp/v2/gsf_member`,
    coverage: 'published_only',
    records,
  };
}

function readWordpressInventory() {
  const parsed = JSON.parse(fs.readFileSync(wordpressInventoryPath, 'utf8'));
  const records = Array.isArray(parsed)
    ? parsed
    : parsed?.wordpress?.records || parsed?.records;
  if (!Array.isArray(records)) {
    throw new Error('WordPress inventory must be an array or contain wordpress.records');
  }
  const feedError = parsed?.feed?.error || null;
  const embeddedFeed = parsed?.feed?.records;
  return {
    inventory: {
      source: wordpressInventoryPath,
      coverage: parsed?.wordpress?.coverage || parsed?.coverage || 'registered_statuses',
      records: records.map((row) => ({
        wp_post_id: row.wp_post_id ?? row.id,
        status: row.status || 'unknown',
        slug: row.slug || '',
        name: row.name || titleText(row.title),
        feed_id: stringId(row.feed_id ?? row.zoho_id ?? row.meta?.zoho_id),
      })),
    },
    embeddedFeed: Array.isArray(embeddedFeed) ? embeddedFeed : null,
    embeddedFeedSource: parsed?.feed?.source || null,
    feedError,
  };
}

function reconcileWordpress(inventory, feed) {
  if (!inventory) return null;
  const feedById = new Map(
    feed.filter((row) => stringId(row.id)).map((row) => [stringId(row.id), row]),
  );
  const publishedRecords = inventory.records.filter((row) => row.status === 'publish');
  const syncMatchRecords = inventory.records.filter(
    (row) => row.status === 'publish' || row.status === 'draft',
  );
  const wpById = groupById(inventory.records, (row) => row.feed_id);
  const publishedById = groupById(publishedRecords, (row) => row.feed_id);
  const syncMatchById = groupById(syncMatchRecords, (row) => row.feed_id);
  const statusCounts = {};
  for (const row of inventory.records) {
    statusCounts[row.status] = (statusCounts[row.status] || 0) + 1;
  }
  const describePost = (row) => ({
    wp_post_id: row.wp_post_id,
    status: row.status,
    name: row.name,
  });
  const missingFrom = (lookup) => feed
    .filter((row) => stringId(row.id) && !lookup.has(stringId(row.id)))
    .map((row) => ({
      feed_id: stringId(row.id),
      name: row.Account_Name || '',
    }));
  return {
    source: inventory.source,
    coverage: inventory.coverage,
    counts_by_status: statusCounts,
    raw_posts: inventory.records.length,
    unique_nonblank_feed_ids: new Set(
      inventory.records.map((row) => row.feed_id).filter(Boolean),
    ).size,
    published_posts: publishedRecords.length,
    published_unique_nonblank_feed_ids: new Set(
      publishedRecords.map((row) => row.feed_id).filter(Boolean),
    ).size,
    sync_match_posts: syncMatchRecords.length,
    sync_match_unique_nonblank_feed_ids: new Set(
      syncMatchRecords.map((row) => row.feed_id).filter(Boolean),
    ).size,
    blank_feed_ids: inventory.records
      .filter((row) => !row.feed_id)
      .map(describePost),
    duplicate_feed_ids: duplicateGroups(
      inventory.records,
      (row) => row.feed_id,
      describePost,
    ),
    duplicate_sync_match_feed_ids: duplicateGroups(
      syncMatchRecords,
      (row) => row.feed_id,
      describePost,
    ),
    stale_posts: inventory.records
      .filter((row) => row.feed_id && !feedById.has(row.feed_id))
      .map((row) => ({
        wp_post_id: row.wp_post_id,
        status: row.status,
        feed_id: row.feed_id,
        name: row.name,
      })),
    published_stale_posts: publishedRecords
      .filter((row) => row.feed_id && !feedById.has(row.feed_id))
      .map((row) => ({
        wp_post_id: row.wp_post_id,
        status: row.status,
        feed_id: row.feed_id,
        name: row.name,
      })),
    feed_ids_missing_from_any_wordpress_status: missingFrom(wpById),
    feed_ids_missing_from_sync_match: missingFrom(syncMatchById),
    feed_ids_missing_from_published: missingFrom(publishedById),
  };
}

function markdown(report) {
  const wp = report.wordpress;
  const lines = [
    `# GSF map reconciliation — ${report.generated_at.slice(0, 10)}`,
    '',
    '| Stage | Raw | Unique stable IDs |',
    '| --- | ---: | ---: |',
    `| Dashboard population | ${report.dashboard.raw_organisations} | ${report.dashboard.unique_feed_ids} |`,
    `| iConnect feed (${report.feed.source}) | ${report.feed.raw_records} | ${report.feed.unique_ids} |`,
  ];
  if (wp) {
    lines.push(`| WordPress published | ${wp.published_posts} | ${wp.published_unique_nonblank_feed_ids} |`);
    if (wp.coverage !== 'published_only') {
      lines.push(`| WordPress publish + draft (sync lookup) | ${wp.sync_match_posts} | ${wp.sync_match_unique_nonblank_feed_ids} |`);
      lines.push(`| WordPress all registered statuses | ${wp.raw_posts} | ${wp.unique_nonblank_feed_ids} |`);
    }
  }
  lines.push(
    '',
    `- Dashboard → feed missing: **${report.dashboard.feed_ids_missing_from_feed.length}**`,
    `- Feed → dashboard unexpected: **${report.dashboard.unexpected_feed_ids.length}**`,
    `- Dashboard duplicate stable IDs: **${report.dashboard.duplicate_feed_ids.length}**`,
    `- Feed duplicate IDs: **${report.feed.duplicate_ids.length}**`,
  );
  if (report.feed.wordpress_export_snapshot_comparison) {
    const comparison = report.feed.wordpress_export_snapshot_comparison;
    lines.push(
      `- Endpoint exactly matches the WordPress-export feed IDs: **${comparison.exact_id_set_match ? 'YES' : 'NO'}**`,
      `- Captured IDs missing from endpoint: **${comparison.captured_ids_missing_from_endpoint.length}**`,
      `- Endpoint IDs missing from capture: **${comparison.endpoint_ids_missing_from_capture.length}**`,
    );
  }
  if (wp) {
    lines.push(
      `- WordPress duplicate IDs across reported statuses: **${wp.duplicate_feed_ids.length}**`,
      `- WordPress duplicate IDs visible to sync lookup: **${wp.duplicate_sync_match_feed_ids.length}**`,
      `- WordPress published stale posts: **${wp.published_stale_posts.length}**`,
      `- WordPress blank IDs: **${wp.blank_feed_ids.length}**`,
      `- Feed IDs missing from published WordPress: **${wp.feed_ids_missing_from_published.length}**`,
      `- Feed IDs absent from sync lookup (publish + draft): **${wp.feed_ids_missing_from_sync_match.length}**`,
    );
    if (wp.feed_ids_missing_from_published.length) {
      lines.push('', '## Feed IDs missing from WordPress', '', '| Feed ID | Organisation |', '| --- | --- |');
      for (const row of wp.feed_ids_missing_from_published) {
        lines.push(`| ${row.feed_id} | ${String(row.name).replace(/\|/g, '\\|')} |`);
      }
    }
    if (wp.published_stale_posts.length) {
      lines.push('', '## Published stale WordPress posts', '', '| Post | Status | Feed ID | Organisation |', '| ---: | --- | --- | --- |');
      for (const row of wp.published_stale_posts) {
        lines.push(`| ${row.wp_post_id} | ${row.status} | ${row.feed_id} | ${String(row.name).replace(/\|/g, '\\|')} |`);
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

const [data, dashboardWidget] = await Promise.all([
  loadGsfMapData(),
  loadDashboardWidget(),
]);
const localFeed = buildMembersPayload(data);

let wordpressInventory = null;
let wordpressExport = null;
if (wordpressInventoryPath) {
  wordpressExport = readWordpressInventory();
  wordpressInventory = wordpressExport.inventory;
} else if (wordpressUrl) {
  wordpressInventory = await fetchPublishedWordpressPosts();
}

let feed = localFeed;
let feedSource = 'local builder against DEST Supabase';
if (apiBase) {
  feed = await fetchMembersEndpoint();
  feedSource = `${apiBase}/api/public/gsf-map/members`;
} else if (wordpressExport) {
  if (wordpressExport.feedError) {
    throw new Error(`WordPress export feed fetch failed: ${wordpressExport.feedError}`);
  }
  if (!wordpressExport.embeddedFeed) {
    throw new Error(
      'WordPress inventory has no embedded feed records; rerun the current WP-CLI diagnostic or pass --api-base',
    );
  }
  feed = wordpressExport.embeddedFeed;
  feedSource = wordpressExport.embeddedFeedSource
    ? `${wordpressExport.embeddedFeedSource} (captured by WordPress export)`
    : `${wordpressInventoryPath} embedded feed`;
}

// Evaluate the deployed widget row instead of inferring the dashboard
// population from a seed script. Fail closed on an unsupported future filter.
const dashboardFilters = Array.isArray(dashboardWidget.config?.filters)
  ? dashboardWidget.config.filters
  : [];
const dashboardRows = data.orgs.filter((org) => {
  const prefs = data.prefByOrg.get(org.id) || {};
  return dashboardFilters.every((filter) => matchesDashboardFilter(org, prefs, filter));
});
const dashboardByFeedId = new Map(
  dashboardRows.map((org) => [stringId(org.zoho_crm_id || org.id), org]),
);
const feedById = new Map(
  feed.filter((row) => stringId(row.id)).map((row) => [stringId(row.id), row]),
);
const wordpressExportSnapshotComparison = apiBase && wordpressExport?.embeddedFeed
  ? compareFeedIdentitySets(
    feed,
    wordpressExport.embeddedFeed,
    wordpressExport.embeddedFeedSource || wordpressInventoryPath,
  )
  : null;

const report = {
  generated_at: new Date().toISOString(),
  dashboard: {
    widget_id: dashboardWidget.id,
    widget_title: dashboardWidget.title,
    widget_scope: dashboardWidget.scope,
    widget_updated_at: dashboardWidget.updated_at,
    filters: dashboardFilters,
    rule: dashboardFilters.length
      ? dashboardFilters.map(dashboardFilterLabel).join(' AND ')
      : '(no filters)',
    raw_organisations: dashboardRows.length,
    unique_feed_ids: dashboardByFeedId.size,
    duplicate_feed_ids: duplicateGroups(
      dashboardRows,
      (org) => org.zoho_crm_id || org.id,
      (org) => ({
        organization_id: org.id,
        name: org.name,
      }),
    ),
    feed_ids_missing_from_feed: [...dashboardByFeedId]
      .filter(([id]) => !feedById.has(id))
      .map(([feed_id, org]) => ({
        feed_id,
        organization_id: org.id,
        name: org.name,
      })),
    unexpected_feed_ids: feed
      .filter((row) => !dashboardByFeedId.has(stringId(row.id)))
      .map((row) => ({
        feed_id: stringId(row.id),
        name: row.Account_Name || '',
      })),
  },
  feed: {
    source: feedSource,
    raw_records: feed.length,
    unique_ids: new Set(feed.map((row) => stringId(row.id)).filter(Boolean)).size,
    blank_ids: feed
      .filter((row) => !stringId(row.id))
      .map((row) => ({ name: row.Account_Name || '' })),
    duplicate_ids: duplicateGroups(
      feed,
      (row) => row.id,
      (row) => ({ name: row.Account_Name || '' }),
    ),
    organization_uuid_fallbacks: data.memberOrgs
      .filter((org) => !org.zoho_crm_id)
      .map((org) => ({
        organization_id: org.id,
        feed_id: org.id,
        name: org.name,
      })),
    wordpress_export_snapshot_comparison: wordpressExportSnapshotComparison,
  },
  wordpress: reconcileWordpress(wordpressInventory, feed),
};

if (includeRecords) {
  report.dashboard.records = dashboardRows.map((org) => {
    const prefs = data.prefByOrg.get(org.id) || {};
    return {
      organization_id: org.id,
      zoho_id: org.zoho_crm_id || null,
      feed_id: org.zoho_crm_id || org.id,
      name: org.name,
      organization_status: org.status,
      is_sample: org.is_sample,
      org_status: prefs[GSF_MAP_FIELD_IDS.org_status] ?? null,
      org_type: prefs[GSF_MAP_FIELD_IDS.org_type] ?? null,
    };
  });
  if (wordpressInventory) report.wordpress.records = wordpressInventory.records;
}

process.stdout.write(format === 'markdown' ? markdown(report) : `${JSON.stringify(report, null, 2)}\n`);
