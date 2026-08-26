<?php

$GLOBALS['test_options'] = [
    'gsf_sync_interval' => 3600,
    'gsf_zoho_countries' => [],
];
$GLOBALS['test_posts'] = [];
$GLOBALS['test_meta'] = [];
$GLOBALS['test_logs'] = [];
$GLOBALS['test_uuid'] = 0;
$GLOBALS['test_insert_count'] = 0;
$GLOBALS['test_update_count'] = 0;
$GLOBALS['test_before_query'] = null;
$GLOBALS['test_db_connection'] = 1;
$GLOBALS['test_db_locks'] = [];

class TestWpdb
{
    public $options = 'wp_options';

    public function prepare($query, ...$args)
    {
        return ['query' => $query, 'args' => $args];
    }

    public function get_var($prepared)
    {
        $query = $prepared['query'];
        if (str_contains($query, 'GET_LOCK')) {
            [$name] = $prepared['args'];
            $owner = $GLOBALS['test_db_locks'][$name]['owner'] ?? null;
            $connection = $GLOBALS['test_db_connection'];
            if ($owner === null || $owner === $connection) {
                $GLOBALS['test_db_locks'][$name] = [
                    'owner' => $connection,
                    'depth' => ($GLOBALS['test_db_locks'][$name]['depth'] ?? 0) + 1,
                ];
                return '1';
            }
            return '0';
        }
        if (str_contains($query, 'IS_USED_LOCK')) {
            [$name] = $prepared['args'];
            return (($GLOBALS['test_db_locks'][$name]['owner'] ?? null) === $GLOBALS['test_db_connection']) ? '1' : '0';
        }
        if (str_contains($query, 'RELEASE_LOCK')) {
            [$name] = $prepared['args'];
            $lock = $GLOBALS['test_db_locks'][$name] ?? null;
            if (!$lock || $lock['owner'] !== $GLOBALS['test_db_connection']) {
                return '0';
            }
            if ($lock['depth'] > 1) {
                $GLOBALS['test_db_locks'][$name]['depth']--;
            } else {
                unset($GLOBALS['test_db_locks'][$name]);
            }
            return '1';
        }
        $key = $prepared['args'][0];
        return array_key_exists($key, $GLOBALS['test_options'])
            ? maybe_serialize($GLOBALS['test_options'][$key])
            : null;
    }

    public function query($prepared)
    {
        if (is_callable($GLOBALS['test_before_query'])) {
            $callback = $GLOBALS['test_before_query'];
            $GLOBALS['test_before_query'] = null;
            $callback($prepared);
        }
        if (str_starts_with(ltrim($prepared['query']), 'UPDATE')) {
            [$replacement, $key, $expected] = $prepared['args'];
            $current = array_key_exists($key, $GLOBALS['test_options'])
                ? maybe_serialize($GLOBALS['test_options'][$key])
                : null;
            if ($current !== $expected) {
                return 0;
            }
            $GLOBALS['test_options'][$key] = maybe_unserialize($replacement);
            return 1;
        }
        if (str_starts_with(ltrim($prepared['query']), 'DELETE')) {
            [$key, $expected] = $prepared['args'];
            $current = array_key_exists($key, $GLOBALS['test_options'])
                ? maybe_serialize($GLOBALS['test_options'][$key])
                : null;
            if ($current !== $expected) {
                return 0;
            }
            unset($GLOBALS['test_options'][$key]);
            return 1;
        }
        throw new RuntimeException('Unexpected test SQL');
    }
}

$GLOBALS['wpdb'] = new TestWpdb();

class GSF_Logger
{
    private static $instance;
    public static function getInstance()
    {
        if (!self::$instance) {
            self::$instance = new self();
        }
        return self::$instance;
    }
    public function log($message, $level, $context = [])
    {
        $GLOBALS['test_logs'][] = compact('message', 'level', 'context');
    }
}

function get_option($key, $default = false)
{
    return array_key_exists($key, $GLOBALS['test_options']) ? $GLOBALS['test_options'][$key] : $default;
}
function update_option($key, $value)
{
    $GLOBALS['test_options'][$key] = $value;
    return true;
}
function add_option($key, $value)
{
    if (array_key_exists($key, $GLOBALS['test_options'])) {
        return false;
    }
    $GLOBALS['test_options'][$key] = $value;
    return true;
}
function delete_option($key)
{
    unset($GLOBALS['test_options'][$key]);
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
function get_post_stati()
{
    return [
        'publish' => 'publish',
        'draft' => 'draft',
        'pending' => 'pending',
        'private' => 'private',
        'future' => 'future',
        'trash' => 'trash',
        'reviewed' => 'reviewed',
    ];
}
function get_posts($args)
{
    $posts = array_values($GLOBALS['test_posts']);
    $statuses = (array) ($args['post_status'] ?? ['publish']);
    $posts = array_values(array_filter($posts, function ($post) use ($statuses) {
        return in_array($post->post_status, $statuses, true);
    }));
    $query = $args['meta_query'][0] ?? null;
    if (is_array($query) && ($query['key'] ?? '') === 'zoho_id' && ($query['compare'] ?? '=') === '=') {
        $wanted = (string) ($query['value'] ?? '');
        $posts = array_values(array_filter($posts, function ($post) use ($wanted) {
            return (string) get_post_meta($post->ID, 'zoho_id', true) === $wanted;
        }));
    }
    usort($posts, function ($left, $right) {
        return $left->ID <=> $right->ID;
    });
    return $posts;
}
function get_post_meta($post_id, $key, $single = false)
{
    return $GLOBALS['test_meta'][$post_id][$key] ?? '';
}
function update_post_meta($post_id, $key, $value)
{
    $GLOBALS['test_meta'][$post_id][$key] = $value;
    return true;
}
function wp_insert_post($data)
{
    $GLOBALS['test_insert_count']++;
    $id = empty($GLOBALS['test_posts']) ? 1 : max(array_keys($GLOBALS['test_posts'])) + 1;
    $GLOBALS['test_posts'][$id] = test_post($id, $data['post_status'], $data['post_title']);
    return $id;
}
function wp_update_post($data)
{
    $GLOBALS['test_update_count']++;
    $post = $GLOBALS['test_posts'][(int) $data['ID']];
    $post->post_title = $data['post_title'];
    $post->post_status = $data['post_status'];
    $post->post_modified = $data['post_modified'];
    return $post->ID;
}
function is_wp_error()
{
    return false;
}
function current_time($type)
{
    return $type === 'mysql' ? '2026-08-25 12:00:00' : time();
}
function wp_generate_uuid4()
{
    $GLOBALS['test_uuid']++;
    return 'test-lock-' . $GLOBALS['test_uuid'];
}
function gsf_clear_community_stats_cache()
{
}
function gsf_normalize_country_name($name)
{
    return $name;
}

function test_post($id, $status, $title)
{
    return (object) [
        'ID' => $id,
        'post_status' => $status,
        'post_title' => $title,
        'post_date' => '2026-01-01 00:00:00',
        'post_modified' => '2026-01-01 00:00:00',
    ];
}
function test_assert($condition, $message)
{
    if (!$condition) {
        fwrite(STDERR, "FAIL: {$message}\n");
        exit(1);
    }
    echo "ok - {$message}\n";
}
function invoke_private($object, $method, ...$args)
{
    $reflection = new ReflectionMethod($object, $method);
    $reflection->setAccessible(true);
    return $reflection->invoke($object, ...$args);
}
function renew_private_lock($object, &$lock)
{
    $reflection = new ReflectionMethod($object, 'renewMemberSyncLock');
    $reflection->setAccessible(true);
    $arguments = [&$lock];
    return $reflection->invokeArgs($object, $arguments);
}
function member_payload($id, $name)
{
    return [
        'id' => $id,
        'Account_Name' => $name,
        'Email' => 'member@example.org',
        'Location_of_HQ_Country' => 'Kenya',
        'Countries_of_Operation' => [],
        'Type_of_Organisation' => 'Non-profit',
        'Website' => 'https://example.org',
        'CEO_First_Name' => 'Test',
        'CEO_Last_Name' => 'Person',
        'Email_of_CEO' => 'ceo@example.org',
        'Account_Type' => 'Member',
        'Lifecycle_Status' => 'Current',
    ];
}

require dirname(__DIR__) . '/class-zoho-api.iconnect.php';

$api = new ZohoAPI();

// A status-hidden post is identity-complete: update it in place and preserve status.
$GLOBALS['test_posts'] = [41 => test_post(41, 'private', 'Old title')];
$GLOBALS['test_meta'] = [41 => ['zoho_id' => 'hidden-1', 'last_sync' => '2025-01-01 00:00:00']];
$stats = invoke_private($api, 'syncMembersToWordPress', [member_payload('hidden-1', 'New title')]);
test_assert($GLOBALS['test_insert_count'] === 0, 'status-hidden identity is not inserted again');
test_assert($GLOBALS['test_posts'][41]->post_status === 'private', 'status-hidden canonical post keeps its status');
test_assert($GLOBALS['test_posts'][41]->post_title === 'New title', 'status-hidden canonical post is updated');
test_assert($stats['last_sync_updated'] === 1, 'canonical per-row last_sync is refreshed');

// Individual countries survive ingestion; summary sentinels and hidden
// countries do not become stored member meta.
$GLOBALS['test_options']['gsf_zoho_countries'] = [
    'Kenya' => ['flag' => 'Show'],
    'Uganda' => ['flag' => 'Show'],
    'Rwanda' => ['flag' => 'Hide'],
    'Multiple locations' => ['flag' => 'Show'],
];
$country_member = member_payload('countries-1', 'Multi-country member');
$country_member['Countries_of_Operation'] = ['Kenya', 'Multiple locations', 'Uganda', 'Rwanda'];
$stats = invoke_private($api, 'syncMembersToWordPress', [$country_member]);
$country_post = $GLOBALS['test_posts'][max(array_keys($GLOBALS['test_posts']))];
test_assert(
    $GLOBALS['test_meta'][$country_post->ID]['countries_of_operation'] === ['Kenya', 'Uganda'],
    'WordPress stores individual visible countries unchanged and rejects the summary sentinel'
);

// Published wins over a lower-ID non-published duplicate; only canonical sync time changes.
$GLOBALS['test_posts'] = [
    10 => test_post(10, 'draft', 'Duplicate draft'),
    20 => test_post(20, 'publish', 'Canonical published'),
];
$GLOBALS['test_meta'] = [
    10 => ['zoho_id' => 'duplicate-1', 'last_sync' => '2024-02-03 04:05:06'],
    20 => ['zoho_id' => 'duplicate-1', 'last_sync' => '2025-02-03 04:05:06'],
];
$stats = invoke_private($api, 'syncMembersToWordPress', [member_payload('duplicate-1', 'Canonical published')]);
test_assert(count($stats['duplicate_feed_ids']) === 1, 'pre-existing duplicate identity is reported');
test_assert($stats['duplicate_feed_ids'][0]['canonical']['wp_post_id'] === 20, 'published duplicate is selected canonically');
test_assert($GLOBALS['test_meta'][10]['last_sync'] === '2024-02-03 04:05:06', 'noncanonical old last_sync remains evidence');
test_assert($GLOBALS['test_meta'][20]['last_sync'] === '2026-08-25 12:00:00', 'canonical last_sync advances');
test_assert(isset($GLOBALS['test_options']['gsf_zoho_last_sync']), 'global last_sync advances with the completed member pass');

// A custom status is included in identity lookup.
$GLOBALS['test_posts'] = [99 => test_post(99, 'reviewed', 'Custom status')];
$GLOBALS['test_meta'] = [99 => ['zoho_id' => 'custom-1']];
$matches = invoke_private($api, 'findMembersByFeedId', 'custom-1');
test_assert(count($matches) === 1 && $matches[0]->ID === 99, 'all registered statuses participate in identity matching');

// The atomic option lock rejects an overlap and is token-owned on release.
unset($GLOBALS['test_options'][ZohoAPI::MEMBER_SYNC_LOCK_OPTION]);
$first = invoke_private($api, 'acquireMemberSyncLock');
$second = invoke_private($api, 'acquireMemberSyncLock');
test_assert($first['acquired'] === true, 'first sync acquires the lock');
test_assert($second['acquired'] === false, 'overlapping sync receives a busy lock result');
invoke_private($api, 'releaseMemberSyncLock', 'not-the-owner');
test_assert(isset($GLOBALS['test_options'][ZohoAPI::MEMBER_SYNC_LOCK_OPTION]), 'non-owner cannot release the lock');
invoke_private($api, 'releaseMemberSyncLock', $first['lock']['token']);
test_assert(!isset($GLOBALS['test_options'][ZohoAPI::MEMBER_SYNC_LOCK_OPTION]), 'owner always releases the lock');

// Expiry takeover is compare-and-swap: a new owner inserted during the race wins.
$GLOBALS['test_options'][ZohoAPI::MEMBER_SYNC_LOCK_OPTION] = [
    'token' => 'expired-owner',
    'acquired_at' => 1,
    'expires_at' => 1,
];
$GLOBALS['test_before_query'] = function ($prepared) {
    if (str_starts_with(ltrim($prepared['query']), 'UPDATE')) {
        $GLOBALS['test_options'][ZohoAPI::MEMBER_SYNC_LOCK_OPTION] = [
            'token' => 'race-winner',
            'acquired_at' => time(),
            'expires_at' => time() + 900,
        ];
    }
};
$lost_takeover = invoke_private($api, 'acquireMemberSyncLock');
test_assert($lost_takeover['acquired'] === false, 'expired takeover cannot overwrite a concurrent new owner');
test_assert($GLOBALS['test_options'][ZohoAPI::MEMBER_SYNC_LOCK_OPTION]['token'] === 'race-winner', 'compare-and-swap preserves the race winner');

// A stale owner cannot release a replacement lease.
invoke_private($api, 'releaseMemberSyncLock', 'expired-owner');
test_assert($GLOBALS['test_options'][ZohoAPI::MEMBER_SYNC_LOCK_OPTION]['token'] === 'race-winner', 'stale-owner release cannot delete a replacement lease');

// A still-owned expired lease renews atomically before the next write.
$renewing = $GLOBALS['test_options'][ZohoAPI::MEMBER_SYNC_LOCK_OPTION] = [
    'token' => 'renewing-owner',
    'acquired_at' => 1,
    'expires_at' => 1,
];
renew_private_lock($api, $renewing);
test_assert($renewing['expires_at'] > time(), 'long-running owner renews its lease before the next write');
test_assert($GLOBALS['test_options'][ZohoAPI::MEMBER_SYNC_LOCK_OPTION]['token'] === 'renewing-owner', 'lease renewal preserves ownership fencing');

// syncWithZoho exposes busy and does not enter fetch/cleanup/upsert.
$GLOBALS['test_options'][ZohoAPI::MEMBER_SYNC_LOCK_OPTION] = [
    'token' => 'held-owner',
    'acquired_at' => time(),
    'expires_at' => time() + 900,
];
$busy = invoke_private($api, 'syncWithZoho');
test_assert($busy['status'] === 'busy', 'overlapping manual or automatic sync reports busy');
invoke_private($api, 'releaseMemberSyncLock', 'held-owner');

echo "All ZohoAPI deduplication regression checks passed.\n";