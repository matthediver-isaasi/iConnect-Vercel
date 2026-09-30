<?php
/**
 * Dry-run-first cleanup for the five reviewed GSF member duplicate identities.
 *
 * Run from the WordPress root:
 *
 *   wp eval-file /path/to/wp-gsf-map-cleanup.php dry-run /tmp/gsf-reviewed-plan.json
 *   wp eval-file /path/to/wp-gsf-map-cleanup.php apply   /tmp/gsf-reviewed-plan.json
 *
 * The plan must use stable feed IDs and exact WordPress post IDs:
 *
 * {
 *   "pairs": [{
 *     "feed_id": "815132000006866401",
 *     "survivor_post_id": 6969,
 *     "noncanonical_post_ids": [1234],
 *     "action": "delete"
 *   }]
 * }
 *
 * "delete" permanently removes an approved noncanonical copy. "trash" archives
 * it but it will remain visible as an all-status duplicate in reconciliation.
 * The script refuses to act unless every live identity set still exactly matches
 * the reviewed plan and the deterministic survivor is published.
 */

if (!defined('ABSPATH')) {
    fwrite(STDERR, "Run this file with wp eval-file from the WordPress root.\n");
    exit(1);
}

const GSF_MEMBER_SYNC_LOCK_OPTION = 'gsf_iconnect_member_sync_lock';
const GSF_MEMBER_SYNC_LOCK_TTL = 900;
const GSF_REVIEWED_DUPLICATE_IDS = [
    '815132000006866401' => 'Abaarso Network',
    '815132000006866292' => 'Rangeet',
    '815132000006866295' => 'Sabre Education',
    '815132000006929885' => 'Learning Equality',
    '815132000012585001' => 'Plato Cultural',
];

function gsf_cleanup_all_statuses()
{
    $statuses = array_values(get_post_stati([], 'names'));
    return empty($statuses) ? ['publish', 'draft', 'pending', 'private', 'future', 'trash'] : $statuses;
}

function gsf_cleanup_matches($feed_id)
{
    return get_posts([
        'post_type' => 'gsf_member',
        'post_status' => gsf_cleanup_all_statuses(),
        'posts_per_page' => -1,
        'orderby' => 'ID',
        'order' => 'ASC',
        'suppress_filters' => false,
        'meta_query' => [[
            'key' => 'zoho_id',
            'value' => $feed_id,
            'compare' => '=',
        ]],
    ]);
}

function gsf_cleanup_canonical($posts)
{
    usort($posts, function ($left, $right) {
        $left_published = $left->post_status === 'publish' ? 0 : 1;
        $right_published = $right->post_status === 'publish' ? 0 : 1;
        if ($left_published !== $right_published) {
            return $left_published <=> $right_published;
        }
        return ((int) $left->ID) <=> ((int) $right->ID);
    });
    return $posts[0] ?? null;
}

function gsf_cleanup_describe($post)
{
    return [
        'wp_post_id' => (int) $post->ID,
        'status' => (string) $post->post_status,
        'name' => html_entity_decode((string) $post->post_title, ENT_QUOTES, 'UTF-8'),
        'feed_id' => trim((string) get_post_meta($post->ID, 'zoho_id', true)),
        'created_at' => (string) $post->post_date,
        'modified_at' => (string) $post->post_modified,
        'last_sync' => (string) get_post_meta($post->ID, 'last_sync', true),
    ];
}

function gsf_cleanup_read_lock_row()
{
    global $wpdb;
    $raw = $wpdb->get_var($wpdb->prepare(
        "SELECT option_value FROM {$wpdb->options} WHERE option_name = %s LIMIT 1",
        GSF_MEMBER_SYNC_LOCK_OPTION
    ));
    if ($raw === null) {
        return null;
    }
    return ['raw' => (string) $raw, 'value' => maybe_unserialize($raw)];
}

function gsf_cleanup_clear_lock_cache()
{
    wp_cache_delete(GSF_MEMBER_SYNC_LOCK_OPTION, 'options');
    wp_cache_delete('alloptions', 'options');
}

function gsf_cleanup_compare_and_swap_lock($expected_raw, $replacement)
{
    global $wpdb;
    $updated = $wpdb->query($wpdb->prepare(
        "UPDATE {$wpdb->options}
         SET option_value = %s
         WHERE option_name = %s AND option_value = %s",
        maybe_serialize($replacement),
        GSF_MEMBER_SYNC_LOCK_OPTION,
        $expected_raw
    ));
    if ($updated === 1) {
        gsf_cleanup_clear_lock_cache();
        return true;
    }
    return false;
}

function gsf_cleanup_acquire_lock()
{
    $now = time();
    $token = function_exists('wp_generate_uuid4')
        ? wp_generate_uuid4()
        : uniqid('gsf-cleanup-', true);
    $lock = [
        'token' => $token,
        'acquired_at' => $now,
        'expires_at' => $now + GSF_MEMBER_SYNC_LOCK_TTL,
        'owner' => 'reviewed_duplicate_cleanup',
    ];
    if (add_option(GSF_MEMBER_SYNC_LOCK_OPTION, $lock, '', false)) {
        return $lock;
    }
    $row = gsf_cleanup_read_lock_row();
    if ($row === null) {
        if (add_option(GSF_MEMBER_SYNC_LOCK_OPTION, $lock, '', false)) {
            return $lock;
        }
        $row = gsf_cleanup_read_lock_row();
    }
    $current = is_array($row['value'] ?? null) ? $row['value'] : [];
    if ((int) ($current['expires_at'] ?? 0) <= $now) {
        if (gsf_cleanup_compare_and_swap_lock($row['raw'], $lock)) {
            return $lock;
        }
        $row = gsf_cleanup_read_lock_row();
        $current = is_array($row['value'] ?? null) ? $row['value'] : [];
    }
    $busy_until = is_array($current) ? (int) ($current['expires_at'] ?? 0) : 0;
    throw new RuntimeException(
        'Member sync/cleanup lock is busy'
        . ($busy_until > 0 ? ' until ' . gmdate('c', $busy_until) : '')
    );
}

function gsf_cleanup_renew_lock(&$lock)
{
    $row = gsf_cleanup_read_lock_row();
    $current = is_array($row['value'] ?? null) ? $row['value'] : [];
    if (
        $row === null
        || !isset($current['token'])
        || !hash_equals((string) $current['token'], (string) ($lock['token'] ?? ''))
    ) {
        throw new RuntimeException('Member sync/cleanup lease ownership was lost');
    }
    $replacement = $current;
    $replacement['expires_at'] = max(
        time() + GSF_MEMBER_SYNC_LOCK_TTL,
        (int) ($current['expires_at'] ?? 0) + 1
    );
    if (!gsf_cleanup_compare_and_swap_lock($row['raw'], $replacement)) {
        throw new RuntimeException('Member sync/cleanup lease renewal lost a concurrent race');
    }
    $lock = $replacement;
}

function gsf_cleanup_release_lock($token)
{
    global $wpdb;
    $row = gsf_cleanup_read_lock_row();
    $current = is_array($row['value'] ?? null) ? $row['value'] : [];
    if (
        $row === null
        || !isset($current['token'])
        || !hash_equals((string) $current['token'], (string) $token)
    ) {
        return;
    }
    $deleted = $wpdb->query($wpdb->prepare(
        "DELETE FROM {$wpdb->options}
         WHERE option_name = %s AND option_value = %s",
        GSF_MEMBER_SYNC_LOCK_OPTION,
        $row['raw']
    ));
    if ($deleted === 1) {
        gsf_cleanup_clear_lock_cache();
    }
}

function gsf_cleanup_validate_plan($plan)
{
    if (!is_array($plan) || !isset($plan['pairs']) || !is_array($plan['pairs']) || empty($plan['pairs'])) {
        throw new InvalidArgumentException('Plan must contain a non-empty pairs array');
    }

    $seen_feed_ids = [];
    $validated = [];
    foreach ($plan['pairs'] as $index => $pair) {
        $feed_id = trim((string) ($pair['feed_id'] ?? ''));
        $survivor_id = (int) ($pair['survivor_post_id'] ?? 0);
        $noncanonical_ids = array_values(array_unique(array_map('intval', $pair['noncanonical_post_ids'] ?? [])));
        sort($noncanonical_ids, SORT_NUMERIC);
        $action = (string) ($pair['action'] ?? '');

        if (!isset(GSF_REVIEWED_DUPLICATE_IDS[$feed_id])) {
            throw new InvalidArgumentException("Pair {$index} feed ID is not one of the five reviewed identities");
        }
        if (isset($seen_feed_ids[$feed_id])) {
            throw new InvalidArgumentException("Feed ID {$feed_id} appears more than once in the plan");
        }
        if ($survivor_id <= 0 || empty($noncanonical_ids) || in_array($survivor_id, $noncanonical_ids, true)) {
            throw new InvalidArgumentException("Pair {$index} has invalid survivor/noncanonical post IDs");
        }
        if (!in_array($action, ['delete', 'trash'], true)) {
            throw new InvalidArgumentException("Pair {$index} action must be exactly delete or trash");
        }

        $matches = gsf_cleanup_matches($feed_id);
        $canonical = gsf_cleanup_canonical($matches);
        $live_ids = array_values(array_map(function ($post) {
            return (int) $post->ID;
        }, $matches));
        sort($live_ids, SORT_NUMERIC);
        $planned_ids = array_merge([$survivor_id], $noncanonical_ids);
        sort($planned_ids, SORT_NUMERIC);

        if ($live_ids !== $planned_ids) {
            throw new RuntimeException(
                "Feed ID {$feed_id} changed since review; live post IDs ["
                . implode(', ', $live_ids)
                . '] do not equal planned IDs ['
                . implode(', ', $planned_ids)
                . ']'
            );
        }
        if ($canonical === null || (int) $canonical->ID !== $survivor_id) {
            throw new RuntimeException("Feed ID {$feed_id} survivor is not the deterministic canonical post");
        }
        if ($canonical->post_status !== 'publish') {
            throw new RuntimeException("Feed ID {$feed_id} survivor is not published; resolve status explicitly before cleanup");
        }

        $validated[] = [
            'organisation' => GSF_REVIEWED_DUPLICATE_IDS[$feed_id],
            'feed_id' => $feed_id,
            'action' => $action,
            'survivor' => gsf_cleanup_describe($canonical),
            'noncanonical' => array_values(array_map('gsf_cleanup_describe', array_filter(
                $matches,
                function ($post) use ($survivor_id) {
                    return (int) $post->ID !== $survivor_id;
                }
            ))),
        ];
        $seen_feed_ids[$feed_id] = true;
    }
    return $validated;
}

$script_args = isset($args) && is_array($args) ? array_values($args) : [];
$mode = (string) ($script_args[0] ?? getenv('GSF_CLEANUP_MODE') ?: 'dry-run');
$plan_path = (string) ($script_args[1] ?? getenv('GSF_CLEANUP_PLAN') ?: '');
$result = [
    'generated_at' => gmdate('c'),
    'mode' => $mode,
    'applied' => false,
    'plan_path' => $plan_path,
    'changes' => [],
];
$lock = null;

try {
    if (!in_array($mode, ['dry-run', 'apply'], true)) {
        throw new InvalidArgumentException('Mode must be dry-run or apply');
    }
    if ($plan_path === '' || !is_readable($plan_path)) {
        throw new InvalidArgumentException('A readable reviewed plan path is required');
    }
    $plan = json_decode((string) file_get_contents($plan_path), true);
    if (!is_array($plan)) {
        throw new InvalidArgumentException('Reviewed plan is not valid JSON');
    }

    $lock = gsf_cleanup_acquire_lock();
    $validated = gsf_cleanup_validate_plan($plan);
    $result['pairs'] = $validated;

    if ($mode === 'apply') {
        if (count($validated) !== count(GSF_REVIEWED_DUPLICATE_IDS)) {
            throw new RuntimeException('Apply requires a reviewed plan containing all five confirmed duplicate identities');
        }
        foreach ($validated as $pair) {
            foreach ($pair['noncanonical'] as $record) {
                gsf_cleanup_renew_lock($lock);
                $post_id = (int) $record['wp_post_id'];
                $changed = $pair['action'] === 'delete'
                    ? wp_delete_post($post_id, true)
                    : wp_trash_post($post_id);
                if (!$changed) {
                    throw new RuntimeException("WordPress failed to {$pair['action']} post {$post_id}");
                }
                $result['changes'][] = [
                    'feed_id' => $pair['feed_id'],
                    'wp_post_id' => $post_id,
                    'action' => $pair['action'],
                ];
            }
        }
        $result['applied'] = true;
        $result['message'] = 'Only the reviewed noncanonical post IDs were changed. Run the all-status reconciliation immediately.';
    } else {
        $result['message'] = 'Dry run only. Review every survivor, noncanonical post, action, timestamp, and last_sync before running apply.';
    }
} catch (Throwable $error) {
    $result['error'] = $error->getMessage();
} finally {
    if (is_array($lock) && isset($lock['token'])) {
        gsf_cleanup_release_lock($lock['token']);
    }
}

echo wp_json_encode($result, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . PHP_EOL;
if (isset($result['error'])) {
    exit(1);
}