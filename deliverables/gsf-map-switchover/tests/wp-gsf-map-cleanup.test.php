<?php

define('ABSPATH', __DIR__);

$identities = [
    ['815132000006866401', 'Abaarso Network', 10, 20],
    ['815132000006866292', 'Rangeet', 30, 40],
    ['815132000006866295', 'Sabre Education', 50, 60],
    ['815132000006929885', 'Learning Equality', 70, 80],
    ['815132000012585001', 'Plato Cultural', 90, 100],
];
$GLOBALS['cleanup_posts'] = [];
$GLOBALS['cleanup_meta'] = [];
foreach ($identities as [$feed_id, $name, $copy_id, $survivor_id]) {
    $GLOBALS['cleanup_posts'][$copy_id] = (object) [
        'ID' => $copy_id,
        'post_status' => 'draft',
        'post_title' => $name,
        'post_date' => '2026-08-25 10:00:00',
        'post_modified' => '2026-08-25 10:00:00',
    ];
    $GLOBALS['cleanup_posts'][$survivor_id] = (object) [
        'ID' => $survivor_id,
        'post_status' => 'publish',
        'post_title' => $name,
        'post_date' => '2026-08-25 10:01:00',
        'post_modified' => '2026-08-25 10:30:00',
    ];
    $GLOBALS['cleanup_meta'][$copy_id] = [
        'zoho_id' => $feed_id,
        'last_sync' => '2026-08-24 09:00:00',
    ];
    $GLOBALS['cleanup_meta'][$survivor_id] = [
        'zoho_id' => $feed_id,
        'last_sync' => '2026-08-25 10:30:58',
    ];
}
$GLOBALS['cleanup_options'] = [];
$GLOBALS['cleanup_deleted'] = [];

class CleanupTestWpdb
{
    public $options = 'wp_options';
    public function prepare($query, ...$args)
    {
        return ['query' => $query, 'args' => $args];
    }
    public function get_var($prepared)
    {
        $key = $prepared['args'][0];
        return array_key_exists($key, $GLOBALS['cleanup_options'])
            ? maybe_serialize($GLOBALS['cleanup_options'][$key])
            : null;
    }
    public function query($prepared)
    {
        if (str_starts_with(ltrim($prepared['query']), 'UPDATE')) {
            [$replacement, $key, $expected] = $prepared['args'];
            $current = array_key_exists($key, $GLOBALS['cleanup_options'])
                ? maybe_serialize($GLOBALS['cleanup_options'][$key])
                : null;
            if ($current !== $expected) {
                return 0;
            }
            $GLOBALS['cleanup_options'][$key] = maybe_unserialize($replacement);
            return 1;
        }
        [$key, $expected] = $prepared['args'];
        $current = array_key_exists($key, $GLOBALS['cleanup_options'])
            ? maybe_serialize($GLOBALS['cleanup_options'][$key])
            : null;
        if ($current !== $expected) {
            return 0;
        }
        unset($GLOBALS['cleanup_options'][$key]);
        return 1;
    }
}

$GLOBALS['wpdb'] = new CleanupTestWpdb();

function get_post_stati()
{
    return ['publish' => 'publish', 'draft' => 'draft', 'trash' => 'trash'];
}
function get_posts($args)
{
    $feed_id = (string) $args['meta_query'][0]['value'];
    return array_values(array_filter($GLOBALS['cleanup_posts'], function ($post) use ($feed_id) {
        return get_post_meta($post->ID, 'zoho_id', true) === $feed_id;
    }));
}
function get_post_meta($post_id, $key)
{
    return $GLOBALS['cleanup_meta'][$post_id][$key] ?? '';
}
function add_option($key, $value)
{
    if (isset($GLOBALS['cleanup_options'][$key])) {
        return false;
    }
    $GLOBALS['cleanup_options'][$key] = $value;
    return true;
}
function get_option($key, $default = false)
{
    return $GLOBALS['cleanup_options'][$key] ?? $default;
}
function delete_option($key)
{
    unset($GLOBALS['cleanup_options'][$key]);
    return true;
}
function maybe_serialize($value)
{
    return is_array($value) || is_object($value) ? serialize($value) : $value;
}
function maybe_unserialize($value)
{
    if (!is_string($value)) {
        return $value;
    }
    $decoded = @unserialize($value);
    return $decoded === false && $value !== 'b:0;' ? $value : $decoded;
}
function wp_cache_delete()
{
    return true;
}
function wp_generate_uuid4()
{
    return 'cleanup-test-lock';
}
function wp_delete_post($post_id)
{
    $GLOBALS['cleanup_deleted'][] = $post_id;
    unset($GLOBALS['cleanup_posts'][$post_id]);
    return (object) ['ID' => $post_id];
}
function wp_trash_post($post_id)
{
    $GLOBALS['cleanup_deleted'][] = $post_id;
    $GLOBALS['cleanup_posts'][$post_id]->post_status = 'trash';
    return $GLOBALS['cleanup_posts'][$post_id];
}
function wp_json_encode($value, $flags = 0)
{
    return json_encode($value, $flags);
}
function cleanup_assert($condition, $message)
{
    if (!$condition) {
        fwrite(STDERR, "FAIL: {$message}\n");
        exit(1);
    }
    echo "ok - {$message}\n";
}

$mode = $argv[1] ?? 'dry-run';
$plan_path = tempnam(sys_get_temp_dir(), 'gsf-cleanup-plan-');
file_put_contents($plan_path, json_encode([
    'pairs' => array_map(function ($identity) {
        return [
            'feed_id' => $identity[0],
            'survivor_post_id' => $identity[3],
            'noncanonical_post_ids' => [$identity[2]],
            'action' => 'delete',
        ];
    }, $identities),
]));
$args = [$mode, $plan_path];

ob_start();
require dirname(__DIR__) . '/wp-gsf-map-cleanup.php';
$json = ob_get_clean();
unlink($plan_path);
$result = json_decode($json, true);

cleanup_assert(is_array($result), 'cleanup emits JSON');
cleanup_assert($result['mode'] === $mode, 'cleanup reports the requested mode');
cleanup_assert($result['pairs'][0]['survivor']['wp_post_id'] === 20, 'dry run shows the deterministic published survivor');
cleanup_assert($result['pairs'][0]['noncanonical'][0]['wp_post_id'] === 10, 'dry run shows the exact noncanonical post');
if ($mode === 'apply') {
    cleanup_assert($result['applied'] === true, 'explicit apply processes the complete five-pair plan');
    cleanup_assert($GLOBALS['cleanup_deleted'] === [10, 30, 50, 70, 90], 'apply changes only reviewed noncanonical IDs');
    cleanup_assert(count($result['changes']) === 5, 'apply reports every changed post ID');
    cleanup_assert(isset($GLOBALS['cleanup_posts'][20]) && !isset($GLOBALS['cleanup_posts'][10]), 'apply preserves the published survivor');
    echo "All targeted cleanup apply checks passed.\n";
} else {
    cleanup_assert($result['applied'] === false, 'cleanup defaults to a non-applying review');
    cleanup_assert(empty($GLOBALS['cleanup_deleted']), 'dry run never deletes or trashes a post');
    cleanup_assert(isset($GLOBALS['cleanup_posts'][10]) && isset($GLOBALS['cleanup_posts'][20]), 'dry run leaves both records untouched');
    echo "All targeted cleanup dry-run checks passed.\n";
}