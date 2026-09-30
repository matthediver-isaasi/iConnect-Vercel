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
 *
 * The five named findings distinguish facts present in WordPress from likely
 * causes. WordPress post rows cannot prove whether a historical duplicate came
 * from a status-hidden lookup or overlapping requests without matching logs.
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
        'created_at' => (string) $post->post_date,
        'created_at_gmt' => (string) $post->post_date_gmt,
        'modified_at' => (string) $post->post_modified,
        'modified_at_gmt' => (string) $post->post_modified_gmt,
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
        $sorted = $matches;
        usort($sorted, function ($left, $right) {
            $left_published = $left['status'] === 'publish' ? 0 : 1;
            $right_published = $right['status'] === 'publish' ? 0 : 1;
            if ($left_published !== $right_published) {
                return $left_published <=> $right_published;
            }
            return $left['wp_post_id'] <=> $right['wp_post_id'];
        });
        $canonical = $sorted[0];
        $noncanonical = array_values(array_filter($sorted, function ($record) use ($canonical) {
            return $record['wp_post_id'] !== $canonical['wp_post_id'];
        }));
        $duplicates[] = [
            'feed_id' => $feed_id,
            'records' => $matches,
            'canonical_record' => $canonical,
            'noncanonical_records' => $noncanonical,
            'cleanup_plan_example' => [
                'feed_id' => $feed_id,
                'survivor_post_id' => $canonical['wp_post_id'],
                'noncanonical_post_ids' => array_values(array_map(function ($record) {
                    return $record['wp_post_id'];
                }, $noncanonical)),
                'action' => 'delete',
            ],
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

$named_organisations = [
    'Abaarso Network',
    'Rangeet',
    'Sabre Education',
    'Learning Equality',
    'Plato Cultural',
];
$named_duplicate_findings = [];
foreach ($named_organisations as $name) {
    $named_records = array_values(array_filter($records, function ($record) use ($name) {
        return strcasecmp(trim($record['name']), $name) === 0;
    }));
    $named_feed_ids = array_values(array_unique(array_filter(array_map(function ($record) {
        return $record['feed_id'];
    }, $named_records), 'strlen')));

    $finding = [
        'organisation' => $name,
        'classification' => 'not_found',
        'feed_id' => count($named_feed_ids) === 1 ? $named_feed_ids[0] : null,
        'title_matched_records' => $named_records,
        'confirmed_evidence' => [],
        'likely_cause' => null,
        'canonical_record' => null,
        'noncanonical_records' => [],
        'cleanup_plan_example' => null,
    ];

    if (count($named_feed_ids) > 1) {
        $finding['classification'] = 'same_title_different_feed_ids';
        $finding['confirmed_evidence'][] = 'Multiple stable feed IDs share this title; they are not treated as duplicates.';
        $named_duplicate_findings[] = $finding;
        continue;
    }
    if (count($named_feed_ids) !== 1) {
        $named_duplicate_findings[] = $finding;
        continue;
    }

    $matches = $posts_by_feed_id[$named_feed_ids[0]] ?? [];
    $sorted = $matches;
    usort($sorted, function ($left, $right) {
        $left_published = $left['status'] === 'publish' ? 0 : 1;
        $right_published = $right['status'] === 'publish' ? 0 : 1;
        if ($left_published !== $right_published) {
            return $left_published <=> $right_published;
        }
        return $left['wp_post_id'] <=> $right['wp_post_id'];
    });
    $canonical = $sorted[0] ?? null;
    $noncanonical = $canonical === null ? [] : array_values(array_filter(
        $sorted,
        function ($record) use ($canonical) {
            return $record['wp_post_id'] !== $canonical['wp_post_id'];
        }
    ));

    $finding['canonical_record'] = $canonical;
    $finding['noncanonical_records'] = $noncanonical;
    if (count($matches) === 1) {
        $finding['classification'] = 'single_record';
        $finding['confirmed_evidence'][] = 'Exactly one WordPress post currently carries this stable feed ID.';
        $named_duplicate_findings[] = $finding;
        continue;
    }

    $finding['classification'] = 'confirmed_duplicate';
    $finding['confirmed_evidence'][] = count($matches) . ' WordPress posts carry the same nonblank stable feed ID.';
    $finding['confirmed_evidence'][] = 'Canonical selection is published-first, then lowest WordPress post ID.';
    $finding['confirmed_evidence'][] = 'Per-record last_sync values are reported verbatim; differing values prove the copies were not updated together.';

    $legacy_hidden = array_values(array_filter($noncanonical, function ($record) {
        return !in_array($record['status'], ['publish', 'draft'], true);
    }));
    if (!empty($legacy_hidden)) {
        $finding['likely_cause'] = 'A noncanonical copy was hidden from the legacy publish/draft-only lookup. This is strongly consistent with status-hidden duplication, but the row alone does not prove which request inserted the other copy.';
    } else {
        $created_times = array_values(array_filter(array_map(function ($record) {
            $parsed = strtotime($record['created_at_gmt'] ?: $record['created_at']);
            return $parsed === false ? null : $parsed;
        }, $matches), function ($value) {
            return $value !== null;
        }));
        if (count($created_times) > 1 && max($created_times) - min($created_times) <= 300) {
            $finding['likely_cause'] = 'The copies were created within five minutes and all were visible to the legacy lookup. This is consistent with overlapping lookup-before-insert requests, but requires request logs for proof.';
        } else {
            $finding['likely_cause'] = 'The legacy one-row lookup updated only one arbitrary match and never reconciled extras. Available post rows do not prove the original insertion path.';
        }
    }
    $finding['cleanup_plan_example'] = [
        'feed_id' => $named_feed_ids[0],
        'survivor_post_id' => $canonical['wp_post_id'],
        'noncanonical_post_ids' => array_values(array_map(function ($record) {
            return $record['wp_post_id'];
        }, $noncanonical)),
        'action' => 'delete',
    ];
    $named_duplicate_findings[] = $finding;
}

$global_last_sync_raw = get_option('gsf_zoho_last_sync', null);
$global_last_sync = null;
if (is_numeric($global_last_sync_raw) && (int) $global_last_sync_raw > 0) {
    $global_last_sync = gmdate('c', (int) $global_last_sync_raw);
} elseif (is_string($global_last_sync_raw) && trim($global_last_sync_raw) !== '') {
    $global_last_sync = $global_last_sync_raw;
}

$strict_clean = $feed_error === null
    && count($feed) === 232
    && count($feed_by_id) === 232
    && empty($blank_feed_records)
    && empty($feed_duplicates)
    && count($records) === 232
    && count(array_filter(array_keys($posts_by_feed_id), 'strlen')) === 232
    && count($published_by_feed_id) === 232
    && empty($duplicates)
    && empty($orphans)
    && empty($stale)
    && empty($missing_from_any_status)
    && empty($missing_from_published);

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
        'global_last_sync_raw' => $global_last_sync_raw,
        'global_last_sync' => $global_last_sync,
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
        'named_duplicate_findings' => $named_duplicate_findings,
        'duplicate_sync_match_feed_ids' => $sync_match_duplicates,
        'orphan_posts' => $orphans,
        'stale_posts' => $stale,
        'feed_ids_missing_from_any_wordpress_status' => $missing_from_any_status,
        'feed_ids_missing_from_sync_match' => $missing_from_sync_match,
        'feed_ids_missing_from_published' => $missing_from_published,
        'records' => $records,
    ],
    'acceptance' => [
        'expected_feed_records' => 232,
        'feed_has_232_raw_and_unique_nonblank_ids' => count($feed) === 232
            && count($feed_by_id) === 232
            && empty($blank_feed_records)
            && empty($feed_duplicates),
        'one_published_wordpress_post_per_feed_id' => count($records) === 232
            && count($published_by_feed_id) === 232
            && empty($missing_from_published),
        'no_duplicate_blank_stale_or_orphan_wordpress_ids' => empty($duplicates)
            && empty($orphans)
            && empty($stale),
        'no_feed_ids_missing_from_wordpress' => empty($missing_from_any_status),
        'strict_post_cleanup_reconciliation_passed' => $strict_clean,
    ],
];

echo wp_json_encode($report, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . PHP_EOL;
