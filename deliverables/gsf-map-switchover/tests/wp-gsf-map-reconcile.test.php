<?php

define('ABSPATH', __DIR__);

$GLOBALS['reconcile_posts'] = [
    (object) [
        'ID' => 10,
        'post_status' => 'draft',
        'post_name' => 'abaarso-network-copy',
        'post_title' => 'Abaarso Network',
        'post_date' => '2026-08-25 10:00:00',
        'post_date_gmt' => '2026-08-25 10:00:00',
        'post_modified' => '2026-08-25 10:00:00',
        'post_modified_gmt' => '2026-08-25 10:00:00',
    ],
    (object) [
        'ID' => 20,
        'post_status' => 'publish',
        'post_name' => 'abaarso-network',
        'post_title' => 'Abaarso Network',
        'post_date' => '2026-08-25 10:01:00',
        'post_date_gmt' => '2026-08-25 10:01:00',
        'post_modified' => '2026-08-25 10:30:00',
        'post_modified_gmt' => '2026-08-25 10:30:00',
    ],
];
$GLOBALS['reconcile_meta'] = [
    10 => [
        'zoho_id' => '815132000006866401',
        'last_sync' => '2026-08-24 09:00:00',
    ],
    20 => [
        'zoho_id' => '815132000006866401',
        'last_sync' => '2026-08-25 10:30:58',
    ],
];

function get_option($key, $default = false)
{
    $options = [
        'gsf_iconnect_base_url' => 'https://iconnect.example',
        'gsf_iconnect_api_key' => 'not-a-real-secret',
        'gsf_zoho_last_sync' => 1787653858,
    ];
    return $options[$key] ?? $default;
}
function wp_remote_get()
{
    return [
        'response' => ['code' => 200],
        'body' => json_encode([[
            'id' => '815132000006866401',
            'Account_Name' => 'Abaarso Network',
        ]]),
    ];
}
function is_wp_error()
{
    return false;
}
function wp_remote_retrieve_response_code($response)
{
    return $response['response']['code'];
}
function wp_remote_retrieve_body($response)
{
    return $response['body'];
}
function get_post_stati()
{
    return [
        'publish' => 'publish',
        'draft' => 'draft',
        'pending' => 'pending',
        'private' => 'private',
        'future' => 'future',
        'trash' => 'trash',
    ];
}
function get_posts()
{
    return $GLOBALS['reconcile_posts'];
}
function get_post_meta($post_id, $key)
{
    return $GLOBALS['reconcile_meta'][$post_id][$key] ?? '';
}
function wp_json_encode($value, $flags = 0)
{
    return json_encode($value, $flags);
}
function reconcile_assert($condition, $message)
{
    if (!$condition) {
        fwrite(STDERR, "FAIL: {$message}\n");
        exit(1);
    }
    echo "ok - {$message}\n";
}

ob_start();
require dirname(__DIR__) . '/wp-gsf-map-reconcile.php';
$json = ob_get_clean();
$report = json_decode($json, true);

reconcile_assert(is_array($report), 'reconciliation emits JSON');
$finding = $report['wordpress']['named_duplicate_findings'][0];
reconcile_assert($finding['organisation'] === 'Abaarso Network', 'named finding is emitted');
reconcile_assert($finding['classification'] === 'confirmed_duplicate', 'same stable ID is classified as confirmed duplicate');
reconcile_assert($finding['canonical_record']['wp_post_id'] === 20, 'published post is the reported canonical survivor');
reconcile_assert($finding['noncanonical_records'][0]['wp_post_id'] === 10, 'noncanonical post ID is reported');
reconcile_assert($finding['noncanonical_records'][0]['status'] === 'draft', 'noncanonical status is reported');
reconcile_assert($finding['noncanonical_records'][0]['last_sync'] === '2026-08-24 09:00:00', 'old noncanonical last_sync is preserved in evidence');
reconcile_assert($finding['canonical_record']['last_sync'] === '2026-08-25 10:30:58', 'canonical last_sync is preserved in evidence');
reconcile_assert(!empty($report['wordpress']['global_last_sync']), 'global last_sync is reported beside per-row timestamps');
reconcile_assert($finding['cleanup_plan_example']['survivor_post_id'] === 20, 'report emits an exact-ID cleanup plan example');

echo "All reconciliation reporting checks passed.\n";