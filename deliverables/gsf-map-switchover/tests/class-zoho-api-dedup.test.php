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
$GLOBALS['test_query_posts'] = [];
$GLOBALS['test_query_index'] = 0;
$GLOBALS['test_current_post'] = null;
$GLOBALS['test_meta_failures'] = [];
$GLOBALS['test_remote_responses'] = [];

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
    if (!empty($GLOBALS['test_meta_failures'][$post_id][$key])) {
        return false;
    }
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
function wp_remote_get()
{
    if (empty($GLOBALS['test_remote_responses'])) {
        throw new RuntimeException('No test remote response queued');
    }
    return array_shift($GLOBALS['test_remote_responses']);
}
function wp_remote_retrieve_response_code($response)
{
    return $response['response_code'] ?? 0;
}
function wp_remote_retrieve_body($response)
{
    return $response['body'] ?? '';
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
function get_the_ID()
{
    return $GLOBALS['test_current_post']->ID;
}
function get_the_title()
{
    return $GLOBALS['test_current_post']->post_title;
}
function wp_reset_postdata()
{
    $GLOBALS['test_current_post'] = null;
}

class WP_Query
{
    public $found_posts = 0;
    private $posts = [];
    private $index = 0;

    public function __construct($args)
    {
        $this->posts = array_values(array_filter(
            $GLOBALS['test_posts'],
            function ($post) use ($args) {
                if (($args['post_status'] ?? 'publish') !== $post->post_status) {
                    return false;
                }
                foreach (($args['meta_query'] ?? []) as $query) {
                    if (!is_array($query) || ($query['key'] ?? '') !== 'countries_of_operation') {
                        continue;
                    }
                    $stored = get_post_meta($post->ID, 'countries_of_operation', true);
                    if (!str_contains(serialize($stored), (string) ($query['value'] ?? ''))) {
                        return false;
                    }
                }
                return true;
            }
        ));
        usort($this->posts, function ($left, $right) {
            return strcmp($left->post_title, $right->post_title);
        });
        $this->found_posts = count($this->posts);
    }

    public function have_posts()
    {
        return $this->index < count($this->posts);
    }

    public function the_post()
    {
        $GLOBALS['test_current_post'] = $this->posts[$this->index++];
    }
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
test_assert(
    ZohoAPI::INTEGRATION_VERSION === '3.1.0',
    'the installed handover exposes an explicit integration version'
);
test_assert(
    invoke_private($api, 'isCountryDataUpgradeRequired') === true,
    'an installation without the country-data version requests a one-time refresh'
);

// A status-hidden post is identity-complete: update it in place and preserve status.
$GLOBALS['test_posts'] = [41 => test_post(41, 'private', 'Old title')];
$GLOBALS['test_meta'] = [41 => ['zoho_id' => 'hidden-1', 'last_sync' => '2025-01-01 00:00:00']];
$stats = invoke_private($api, 'syncMembersToWordPress', [member_payload('hidden-1', 'New title')]);
test_assert($GLOBALS['test_insert_count'] === 0, 'status-hidden identity is not inserted again');
test_assert($GLOBALS['test_posts'][41]->post_status === 'private', 'status-hidden canonical post keeps its status');
test_assert($GLOBALS['test_posts'][41]->post_title === 'New title', 'status-hidden canonical post is updated');
test_assert($stats['last_sync_updated'] === 1, 'canonical per-row last_sync is refreshed');

// A normal sync replaces stale summary metadata with individual visible
// countries; hidden countries and summary sentinels are not persisted.
$GLOBALS['test_options']['gsf_zoho_countries'] = [
    'Kenya' => ['flag' => 'Show'],
    'Uganda' => ['flag' => 'Show'],
    'Rwanda' => ['flag' => 'Hide'],
    'Multiple locations' => ['flag' => 'Show'],
];
$GLOBALS['test_posts'] = [51 => test_post(51, 'publish', 'Multi-country member')];
$GLOBALS['test_meta'] = [
    51 => [
        'zoho_id' => 'countries-1',
        'countries_of_operation' => ['Multiple locations'],
    ],
];
$country_member = member_payload('countries-1', 'Multi-country member');
$country_member['Countries_of_Operation'] = ['Kenya', 'Multiple locations', 'Uganda', 'Rwanda'];
$stats = invoke_private($api, 'syncMembersToWordPress', [$country_member]);
test_assert(
    $GLOBALS['test_meta'][51]['countries_of_operation'] === ['Kenya', 'Uganda'],
    'normal sync replaces stale summary meta with individual visible countries'
);
$GLOBALS['test_options'][ZohoAPI::COUNTRY_DATA_VERSION_OPTION] = ZohoAPI::COUNTRY_DATA_VERSION;
test_assert(
    invoke_private($api, 'isCountryDataUpgradeRequired') === false,
    'the one-time refresh is satisfied only by the current country-data version'
);
$public_members = $api->getMembers(1, 200, [], false);
test_assert(
    $public_members['members'][0]['Countries_of_Operation'] === ['Kenya', 'Uganda'],
    'public member response preserves the multi-country array used by the existing tooltip'
);
$filtered_members = $api->getMembers(1, 200, ['country' => 'Uganda'], false);
test_assert(
    count($filtered_members['members']) === 1,
    'country filtering continues to match the individual country collection'
);
$GLOBALS['test_meta'][51]['countries_of_operation'] = ['Multiple locations', 'Kenya'];
$guarded_members = $api->getMembers(1, 200, [], false);
test_assert(
    $guarded_members['members'][0]['Countries_of_Operation'] === ['Kenya'],
    'public member response never exposes a stale summary sentinel'
);

// A successful empty country feed is authoritative. It must clear the option
// and stale member metadata rather than leaving the version upgrade retrying.
$GLOBALS['test_options']['gsf_iconnect_base_url'] = 'https://iconnect.test';
$GLOBALS['test_options']['gsf_iconnect_api_key'] = 'test-key';
$GLOBALS['test_options']['gsf_zoho_countries'] = [
    'Kenya' => ['flag' => 'Show'],
];
$GLOBALS['test_remote_responses'][] = [
    'response_code' => 200,
    'body' => '[]',
];
test_assert(
    invoke_private($api, 'syncCountriesFromZoho') === true
        && $GLOBALS['test_options']['gsf_zoho_countries'] === [],
    'an empty authoritative LMIC country feed replaces stale country options'
);
$GLOBALS['test_meta'][51]['countries_of_operation'] = ['Kenya'];
$empty_country_member = member_payload('countries-1', 'Multi-country member');
$empty_stats = invoke_private($api, 'syncMembersToWordPress', [$empty_country_member]);
test_assert(
    $empty_stats['failed'] === 0
        && $GLOBALS['test_meta'][51]['countries_of_operation'] === [],
    'an empty LMIC selection clears stale member country metadata'
);
unset($GLOBALS['test_options'][ZohoAPI::COUNTRY_DATA_VERSION_OPTION]);
$empty_completed_result = invoke_private(
    $api,
    'finalizeMemberSyncResult',
    $empty_stats,
    1,
    1,
    0,
    time()
);
test_assert(
    $empty_completed_result['status'] === 'completed'
        && $GLOBALS['test_options'][ZohoAPI::COUNTRY_DATA_VERSION_OPTION] === ZohoAPI::COUNTRY_DATA_VERSION,
    'an empty LMIC refresh can record the current country-data version'
);

// A non-empty malformed response is not the same as an intentionally empty
// LMIC selection and must preserve the last known-good country option.
$GLOBALS['test_options']['gsf_zoho_countries'] = [
    'Kenya' => ['flag' => 'Show'],
];
$GLOBALS['test_remote_responses'][] = [
    'response_code' => 200,
    'body' => '[{}]',
];
test_assert(
    invoke_private($api, 'syncCountriesFromZoho') === false
        && $GLOBALS['test_options']['gsf_zoho_countries'] === [
            'Kenya' => ['flag' => 'Show'],
        ],
    'a malformed non-empty country feed cannot clear the last known-good option'
);
$GLOBALS['test_remote_responses'][] = [
    'response_code' => 500,
    'body' => '{"error":"Failed to load tenant LMIC countries"}',
];
test_assert(
    invoke_private($api, 'syncCountriesFromZoho') === false
        && $GLOBALS['test_options']['gsf_zoho_countries'] === [
            'Kenya' => ['flag' => 'Show'],
        ],
    'an LMIC API failure cannot clear the last known-good country option'
);

// A failed country-meta write makes the member pass and final sync result fail,
// leaving the version unset so the next automatic request retries.
unset($GLOBALS['test_options'][ZohoAPI::COUNTRY_DATA_VERSION_OPTION]);
$GLOBALS['test_meta'][51]['countries_of_operation'] = ['Multiple locations'];
$GLOBALS['test_meta_failures'][51]['countries_of_operation'] = true;
$failed_country_member = member_payload('countries-1', 'Multi-country member');
$failed_country_member['Countries_of_Operation'] = ['Kenya', 'Uganda'];
$failed_stats = invoke_private($api, 'syncMembersToWordPress', [$failed_country_member]);
test_assert(
    $failed_stats['failed'] === 1,
    'failed country metadata read-back marks the member pass failed'
);
$failed_result = invoke_private(
    $api,
    'finalizeMemberSyncResult',
    $failed_stats,
    1,
    1,
    0,
    time()
);
test_assert(
    $failed_result['status'] === 'failed'
        && $failed_result['reason'] === 'member_metadata_refresh_failed',
    'partial member refresh is reported as failed rather than completed'
);
test_assert(
    !isset($GLOBALS['test_options'][ZohoAPI::COUNTRY_DATA_VERSION_OPTION]),
    'partial member refresh leaves the country-data version unset for retry'
);
unset($GLOBALS['test_meta_failures'][51]['countries_of_operation']);
$completed_result = invoke_private(
    $api,
    'finalizeMemberSyncResult',
    ['failed' => 0, 'duplicate_feed_ids' => []],
    1,
    1,
    0,
    time()
);
test_assert(
    $completed_result['status'] === 'completed'
        && $GLOBALS['test_options'][ZohoAPI::COUNTRY_DATA_VERSION_OPTION] === ZohoAPI::COUNTRY_DATA_VERSION,
    'only a fully successful member refresh records the country-data version'
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

// The administrator refresh bypasses a fresh timestamp/version, reloads the
// country allow-list, and reapplies it to member metadata in the same sync.
$GLOBALS['test_posts'] = [];
$GLOBALS['test_meta'] = [];
$GLOBALS['test_insert_count'] = 0;
$GLOBALS['test_update_count'] = 0;
$GLOBALS['test_options']['gsf_zoho_countries'] = [
    'Uruguay' => ['flag' => 'Show'],
];
$GLOBALS['test_options']['gsf_zoho_last_country_sync'] = time();
$GLOBALS['test_options'][ZohoAPI::COUNTRY_DATA_VERSION_OPTION] = ZohoAPI::COUNTRY_DATA_VERSION;
$GLOBALS['test_remote_responses'] = [
    [
        'response_code' => 200,
        'body' => json_encode([
            [
                'id' => 'country-chile',
                'Country' => ['id' => 'country-chile', 'name' => 'Chile'],
                'Flag' => 'Show',
            ],
        ]),
    ],
    [
        'response_code' => 200,
        'body' => json_encode([
            array_merge(member_payload('aptus-id', 'Aptus'), [
                'Location_of_HQ_Country' => 'Chile',
                'Countries_of_Operation' => ['Chile', 'Uruguay'],
            ]),
        ]),
    ],
];
$refresh_api = new ZohoAPI();
$refresh_result = $refresh_api->forceSyncCountryDataAndMembers();
$refreshed_post_id = array_key_first($GLOBALS['test_posts']);
test_assert(
    $refresh_result['status'] === 'completed'
        && $refresh_result['total_members_fetched'] === 1,
    'administrator refresh completes the guarded country and member sync'
);
test_assert(
    array_keys($GLOBALS['test_options']['gsf_zoho_countries']) === ['Chile'],
    'administrator refresh bypasses the normal daily country-cache interval'
);
test_assert(
    $GLOBALS['test_meta'][$refreshed_post_id]['countries_of_operation'] === ['Chile'],
    'administrator refresh immediately reapplies the new country allow-list to member metadata'
);

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