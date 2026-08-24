<?php
/**
 * Read-only GSF map reconciliation for WP-CLI.
 *
 * Run from the WordPress root:
 *   wp eval-file /path/to/wp-gsf-map-reconcile.php > /tmp/gsf-wordpress-inventory.json
 *
 * The report includes publish/draft/pending/private/future/trash gsf_member
 * posts and compares their zoho_id values with the currently configured
 * iConnect feed. It never creates, updates, deletes, or changes post status.
 */

if (!defined('ABSPATH')) {
    fwrite(STDERR, "Run this file with wp eval-file from the WordPress root.\n");
    exit(1);
}

$base_url = rtrim(trim((string) get_option('gsf_iconnect_base_url', '')), '/');
$api_key = trim((string) get_option('gsf_iconnect_api_key', ''));
$feed = [];
$feed_error = null;

if ($base_url === '' || $api_key === '') {
    $feed_error = 'Missing gsf_iconnect_base_url or gsf_iconnect_api_key option';
} else {
    $response = wp_remote_get($base_url . '/api/public/gsf-map/members', [
        'headers' => [
            'X-Api-Key' => $api_key,
            'Accept' => 'application/json',
        ],
        'timeout' => 60,
    ]);
    if (is_wp_error($response)) {
        $feed_error = $response->get_error_message();
    } else {
        $status = wp_remote_retrieve_response_code($response);
        $decoded = json_decode(wp_remote_retrieve_body($response), true);
        if ($status !== 200) {
            $feed_error = 'iConnect feed returned HTTP ' . $status;
        } elseif (!is_array($decoded)) {
            $feed_error = 'iConnect feed did not return a JSON array';
        } else {
            $feed = $decoded;
        }
    }
}

$post_statuses = array_values(get_post_stati([], 'names'));
$posts = get_posts([
    'post_type' => 'gsf_member',
    'post_status' => $post_statuses,
    'posts_per_page' => -1,
    'orderby' => 'ID',
    'order' => 'ASC',
    'suppress_filters' => false,
]);

$records = [];
$counts_by_status = [];
$posts_by_feed_id = [];
$published_by_feed_id = [];
$sync_match_by_feed_id = [];
foreach ($posts as $post) {
    $feed_id = trim((string) get_post_meta($post->ID, 'zoho_id', true));
    $record = [
        'wp_post_id' => (int) $post->ID,
        'status' => (string) $post->post_status,
        'slug' => (string) $post->post_name,
        'name' => html_entity_decode((string) $post->post_title, ENT_QUOTES, 'UTF-8'),
        'feed_id' => $feed_id,
        'last_sync' => (string) get_post_meta($post->ID, 'last_sync', true),
    ];
    $records[] = $record;
    $counts_by_status[$record['status']] = ($counts_by_status[$record['status']] ?? 0) + 1;
    $posts_by_feed_id[$feed_id] = $posts_by_feed_id[$feed_id] ?? [];
    $posts_by_feed_id[$feed_id][] = $record;
    if ($record['status'] === 'publish') {
        $published_by_feed_id[$feed_id] = $published_by_feed_id[$feed_id] ?? [];
        $published_by_feed_id[$feed_id][] = $record;
    }
    if ($record['status'] === 'publish' || $record['status'] === 'draft') {
        $sync_match_by_feed_id[$feed_id] = $sync_match_by_feed_id[$feed_id] ?? [];
        $sync_match_by_feed_id[$feed_id][] = $record;
    }
}

$feed_by_id = [];
$blank_feed_records = [];
foreach ($feed as $row) {
    $id = trim((string) ($row['id'] ?? ''));
    if ($id === '') {
        $blank_feed_records[] = ['name' => (string) ($row['Account_Name'] ?? '')];
        continue;
    }
    $feed_by_id[$id] = $feed_by_id[$id] ?? [];
    $feed_by_id[$id][] = $row;
}

$duplicates = [];
$sync_match_duplicates = [];
$orphans = [];
foreach ($posts_by_feed_id as $feed_id => $matches) {
    if ($feed_id === '') {
        $orphans = $matches;
    } elseif (count($matches) > 1) {
        $duplicates[] = [
            'feed_id' => $feed_id,
            'records' => $matches,
        ];
    }
}
foreach ($sync_match_by_feed_id as $feed_id => $matches) {
    if ($feed_id !== '' && count($matches) > 1) {
        $sync_match_duplicates[] = [
            'feed_id' => $feed_id,
            'records' => $matches,
        ];
    }
}

$stale = array_values(array_filter($records, function ($record) use ($feed_by_id) {
    return $record['feed_id'] !== '' && !isset($feed_by_id[$record['feed_id']]);
}));

$missing_from_any_status = [];
$missing_from_sync_match = [];
$missing_from_published = [];
foreach ($feed_by_id as $feed_id => $rows) {
    if (!isset($posts_by_feed_id[$feed_id])) {
        $missing_from_any_status[] = [
            'feed_id' => $feed_id,
            'name' => (string) ($rows[0]['Account_Name'] ?? ''),
        ];
    }
    if (!isset($sync_match_by_feed_id[$feed_id])) {
        $missing_from_sync_match[] = [
            'feed_id' => $feed_id,
            'name' => (string) ($rows[0]['Account_Name'] ?? ''),
        ];
    }
    if (!isset($published_by_feed_id[$feed_id])) {
        $missing_from_published[] = [
            'feed_id' => $feed_id,
            'name' => (string) ($rows[0]['Account_Name'] ?? ''),
        ];
    }
}

$feed_duplicates = [];
foreach ($feed_by_id as $feed_id => $rows) {
    if (count($rows) > 1) {
        $feed_duplicates[] = [
            'feed_id' => $feed_id,
            'names' => array_values(array_map(function ($row) {
                return (string) ($row['Account_Name'] ?? '');
            }, $rows)),
        ];
    }
}

$report = [
    'generated_at' => gmdate('c'),
    'read_only' => true,
    'feed' => [
        'source' => $base_url === '' ? null : $base_url . '/api/public/gsf-map/members',
        'error' => $feed_error,
        'raw_records' => count($feed),
        'unique_nonblank_ids' => count($feed_by_id),
        'blank_ids' => $blank_feed_records,
        'duplicate_ids' => $feed_duplicates,
        'records' => array_values(array_map(function ($row) {
            return [
                'id' => trim((string) ($row['id'] ?? '')),
                'Account_Name' => (string) ($row['Account_Name'] ?? ''),
            ];
        }, $feed)),
    ],
    'wordpress' => [
        'coverage' => 'registered_statuses',
        'registered_post_statuses' => $post_statuses,
        'raw_posts' => count($records),
        'counts_by_status' => $counts_by_status,
        'unique_nonblank_feed_ids' => count(array_filter(array_keys($posts_by_feed_id), 'strlen')),
        'published_posts' => count(array_filter($records, function ($record) {
            return $record['status'] === 'publish';
        })),
        'published_unique_nonblank_feed_ids' => count(array_filter(array_keys($published_by_feed_id), 'strlen')),
        'sync_match_posts' => count(array_filter($records, function ($record) {
            return $record['status'] === 'publish' || $record['status'] === 'draft';
        })),
        'sync_match_unique_nonblank_feed_ids' => count(array_filter(array_keys($sync_match_by_feed_id), 'strlen')),
        'duplicate_feed_ids' => $duplicates,
        'duplicate_sync_match_feed_ids' => $sync_match_duplicates,
        'orphan_posts' => $orphans,
        'stale_posts' => $stale,
        'feed_ids_missing_from_any_wordpress_status' => $missing_from_any_status,
        'feed_ids_missing_from_sync_match' => $missing_from_sync_match,
        'feed_ids_missing_from_published' => $missing_from_published,
        'records' => $records,
    ],
];

echo wp_json_encode($report, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . PHP_EOL;
