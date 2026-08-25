<?php

/*
 * Self-contained regression harness for the temporary browser cleanup.
 * Run with: php tests/class-zoho-api-browser-cleanup.test.php
 */

define('ABSPATH', __DIR__ . '/');

$GLOBALS['bc_hooks'] = [];
$GLOBALS['bc_submenus'] = [];
$GLOBALS['bc_options'] = [];
$GLOBALS['bc_transients'] = [];
$GLOBALS['bc_posts'] = [];
$GLOBALS['bc_meta'] = [];
$GLOBALS['bc_feed'] = [];
$GLOBALS['bc_deleted'] = [];
$GLOBALS['bc_uuid'] = 0;
$GLOBALS['bc_can_manage'] = true;
$GLOBALS['bc_hide_survivor'] = null;
$GLOBALS['bc_delete_call'] = 0;
$GLOBALS['bc_delete_fail_on'] = null;
$GLOBALS['bc_after_delete'] = null;
$GLOBALS['bc_on_set_transient'] = null;
$GLOBALS['bc_on_before_delete'] = null;
$GLOBALS['bc_db_connection'] = 1;
$GLOBALS['bc_db_locks'] = [];

class BrowserCleanupWpdb
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
            $owner = $GLOBALS['bc_db_locks'][$name]['owner'] ?? null;
            $connection = $GLOBALS['bc_db_connection'];
            if ($owner === null || $owner === $connection) {
                $GLOBALS['bc_db_locks'][$name] = [
                    'owner' => $connection,
                    'depth' => ($GLOBALS['bc_db_locks'][$name]['depth'] ?? 0) + 1,
                ];
                return '1';
            }
            return '0';
        }
        if (str_contains($query, 'IS_USED_LOCK')) {
            [$name] = $prepared['args'];
            return (($GLOBALS['bc_db_locks'][$name]['owner'] ?? null) === $GLOBALS['bc_db_connection']) ? '1' : '0';
        }
        if (str_contains($query, 'RELEASE_LOCK')) {
            [$name] = $prepared['args'];
            $lock = $GLOBALS['bc_db_locks'][$name] ?? null;
            if (!$lock || $lock['owner'] !== $GLOBALS['bc_db_connection']) {
                return '0';
            }
            if ($lock['depth'] > 1) {
                $GLOBALS['bc_db_locks'][$name]['depth']--;
            } else {
                unset($GLOBALS['bc_db_locks'][$name]);
            }
            return '1';
        }
        $key = $prepared['args'][0];
        return array_key_exists($key, $GLOBALS['bc_options'])
            ? maybe_serialize($GLOBALS['bc_options'][$key])
            : null;
    }

    public function query($prepared)
    {
        if (str_starts_with(ltrim($prepared['query']), 'UPDATE')) {
            [$replacement, $key, $expected] = $prepared['args'];
            $current = array_key_exists($key, $GLOBALS['bc_options'])
                ? maybe_serialize($GLOBALS['bc_options'][$key])
                : null;
            if ($current !== $expected) {
                return 0;
            }
            $GLOBALS['bc_options'][$key] = maybe_unserialize($replacement);
            return 1;
        }
        if (str_starts_with(ltrim($prepared['query']), 'DELETE')) {
            [$key, $expected] = $prepared['args'];
            $current = array_key_exists($key, $GLOBALS['bc_options'])
                ? maybe_serialize($GLOBALS['bc_options'][$key])
                : null;
            if ($current !== $expected) {
                return 0;
            }
            unset($GLOBALS['bc_options'][$key]);
            return 1;
        }
        throw new RuntimeException('Unexpected SQL in browser cleanup harness');
    }
}

$GLOBALS['wpdb'] = new BrowserCleanupWpdb();

class GSF_Logger
{
    public static function getInstance()
    {
        return new self();
    }
    public function log()
    {
    }
}

function add_action($hook, $callback)
{
    $GLOBALS['bc_hooks'][$hook][] = $callback;
}
function add_submenu_page(...$args)
{
    $GLOBALS['bc_submenus'][] = $args;
}
function get_option($key, $default = false)
{
    return array_key_exists($key, $GLOBALS['bc_options']) ? $GLOBALS['bc_options'][$key] : $default;
}
function add_option($key, $value)
{
    if (array_key_exists($key, $GLOBALS['bc_options'])) {
        return false;
    }
    $GLOBALS['bc_options'][$key] = $value;
    return true;
}
function update_option($key, $value)
{
    $GLOBALS['bc_options'][$key] = $value;
    return true;
}
function delete_option($key)
{
    unset($GLOBALS['bc_options'][$key]);
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
function set_transient($key, $value)
{
    $GLOBALS['bc_transients'][$key] = $value;
    if (is_callable($GLOBALS['bc_on_set_transient'])) {
        ($GLOBALS['bc_on_set_transient'])($key, $value);
    }
    return true;
}
function get_transient($key)
{
    return $GLOBALS['bc_transients'][$key] ?? false;
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
function get_posts($args)
{
    $posts = array_values($GLOBALS['bc_posts']);
    $statuses = (array) ($args['post_status'] ?? ['publish']);
    $posts = array_values(array_filter($posts, function ($post) use ($statuses) {
        return in_array($post->post_status, $statuses, true);
    }));
    $query = $args['meta_query'][0] ?? null;
    if ($query && ($query['key'] ?? '') === 'zoho_id') {
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
function get_post($post_id)
{
    if ((int) $GLOBALS['bc_hide_survivor'] === (int) $post_id) {
        return null;
    }
    return $GLOBALS['bc_posts'][(int) $post_id] ?? null;
}
function get_post_meta($post_id, $key)
{
    return $GLOBALS['bc_meta'][(int) $post_id][$key] ?? '';
}
function wp_delete_post($post_id, $force_delete = false)
{
    $post_id = (int) $post_id;
    $GLOBALS['bc_delete_call']++;
    if (is_callable($GLOBALS['bc_on_before_delete'])) {
        ($GLOBALS['bc_on_before_delete'])($post_id, $GLOBALS['bc_delete_call']);
    }
    if ((int) $GLOBALS['bc_delete_fail_on'] === $GLOBALS['bc_delete_call']) {
        return false;
    }
    $GLOBALS['bc_deleted'][] = ['id' => $post_id, 'force' => $force_delete];
    $post = $GLOBALS['bc_posts'][$post_id] ?? null;
    unset($GLOBALS['bc_posts'][$post_id], $GLOBALS['bc_meta'][$post_id]);
    if (is_callable($GLOBALS['bc_after_delete'])) {
        ($GLOBALS['bc_after_delete'])($post_id, $GLOBALS['bc_delete_call']);
    }
    return $post;
}
function wp_remote_get()
{
    return ['response' => ['code' => 200], 'body' => json_encode($GLOBALS['bc_feed'])];
}
function wp_remote_retrieve_response_code($response)
{
    return $response['response']['code'];
}
function wp_remote_retrieve_body($response)
{
    return $response['body'];
}
function is_wp_error()
{
    return false;
}
function wp_json_encode($value, $flags = 0)
{
    return json_encode($value, $flags);
}
function wp_generate_uuid4()
{
    $GLOBALS['bc_uuid']++;
    return 'browser-cleanup-token-' . $GLOBALS['bc_uuid'];
}
function current_user_can()
{
    return $GLOBALS['bc_can_manage'];
}
function wp_verify_nonce($nonce, $action)
{
    return is_string($nonce) && hash_equals('nonce:' . $action, $nonce);
}
function wp_unslash($value)
{
    return $value;
}
function sanitize_key($value)
{
    return preg_replace('/[^a-z0-9_\\-]/', '', strtolower((string) $value));
}
function get_current_user_id()
{
    return 7;
}
function admin_url($path = '')
{
    return '/wp-admin/' . $path;
}
function esc_html($value)
{
    return htmlspecialchars((string) $value, ENT_QUOTES, 'UTF-8');
}
function esc_attr($value)
{
    return esc_html($value);
}
function esc_url($value)
{
    return esc_html($value);
}
function esc_textarea($value)
{
    return esc_html($value);
}
function wp_nonce_field($action, $name)
{
    echo '<input type="hidden" name="' . esc_attr($name) . '" value="nonce:' . esc_attr($action) . '">';
}
function wp_nonce_url($url)
{
    return $url;
}
function submit_button($text)
{
    echo '<button type="submit">' . esc_html($text) . '</button>';
}
function wp_die($message)
{
    throw new RuntimeException($message);
}

function bc_post($id, $status, $title)
{
    return (object) [
        'ID' => $id,
        'post_status' => $status,
        'post_title' => $title,
        'post_date' => '2026-08-25 10:00:00',
        'post_date_gmt' => '2026-08-25 10:00:00',
        'post_modified' => '2026-08-25 10:30:00',
        'post_modified_gmt' => '2026-08-25 10:30:00',
    ];
}

function bc_reset_fixture()
{
    $reviewed = GSF_Reviewed_Duplicate_Cleanup_Admin::REVIEWED_IDENTITIES;
    $GLOBALS['bc_options'] = [
        'gsf_iconnect_base_url' => 'https://iconnect.example',
        'gsf_iconnect_api_key' => 'test-key',
    ];
    $GLOBALS['bc_transients'] = [];
    $GLOBALS['bc_posts'] = [];
    $GLOBALS['bc_meta'] = [];
    $GLOBALS['bc_feed'] = [];
    $GLOBALS['bc_deleted'] = [];
    $GLOBALS['bc_hide_survivor'] = null;
    $GLOBALS['bc_delete_call'] = 0;
    $GLOBALS['bc_delete_fail_on'] = null;
    $GLOBALS['bc_after_delete'] = null;
    $GLOBALS['bc_on_set_transient'] = null;
    $GLOBALS['bc_on_before_delete'] = null;
    $GLOBALS['bc_db_connection'] = 1;
    $GLOBALS['bc_db_locks'] = [];
    $GLOBALS['bc_can_manage'] = true;

    $identities = $reviewed;
    for ($i = 1; count($identities) < 232; $i++) {
        $id = 'synthetic-' . str_pad((string) $i, 4, '0', STR_PAD_LEFT);
        $identities[$id] = 'Synthetic Member ' . $i;
    }

    $post_id = 1000;
    foreach ($identities as $feed_id => $name) {
        $GLOBALS['bc_feed'][] = ['id' => $feed_id, 'Account_Name' => $name];
        $GLOBALS['bc_posts'][$post_id] = bc_post($post_id, 'publish', $name);
        $GLOBALS['bc_meta'][$post_id] = ['zoho_id' => $feed_id, 'last_sync' => '2026-08-25 10:30:58'];
        if (isset($reviewed[$feed_id])) {
            $copy_id = $post_id + 10000;
            $GLOBALS['bc_posts'][$copy_id] = bc_post($copy_id, 'draft', $name . ' reviewed copy');
            $GLOBALS['bc_meta'][$copy_id] = ['zoho_id' => $feed_id, 'last_sync' => '2026-08-24 09:00:00'];
        }
        $post_id++;
    }
}

function bc_assert($condition, $message)
{
    if (!$condition) {
        fwrite(STDERR, "FAIL: {$message}\n");
        exit(1);
    }
    echo "ok - {$message}\n";
}

function bc_throws($callback, $fragment, $message)
{
    try {
        $callback();
    } catch (Throwable $error) {
        bc_assert(str_contains($error->getMessage(), $fragment), $message);
        return;
    }
    bc_assert(false, $message);
}

require dirname(__DIR__) . '/class-zoho-api.iconnect.php';

bc_assert(isset($GLOBALS['bc_hooks']['admin_menu']), 'admin menu hook is registered');
bc_assert(isset($GLOBALS['bc_hooks']['admin_post_gsf_reviewed_duplicate_cleanup']), 'cleanup POST hook is registered');
bc_assert(isset($GLOBALS['bc_hooks']['admin_post_gsf_reviewed_duplicate_cleanup_download']), 'evidence download hook is registered');
GSF_Reviewed_Duplicate_Cleanup_Admin::registerMenu();
bc_assert(
    $GLOBALS['bc_submenus'][0][0] === 'edit.php?post_type=gsf_member'
    && $GLOBALS['bc_submenus'][0][3] === 'manage_options',
    'cleanup page is an administrator member submenu'
);

bc_reset_fixture();
$render_before = serialize([$GLOBALS['bc_posts'], $GLOBALS['bc_meta']]);
ob_start();
GSF_Reviewed_Duplicate_Cleanup_Admin::renderPage();
$rendered = ob_get_clean();
bc_assert(str_contains($rendered, 'Live all-status reconciliation'), 'admin page renders the read-only live report');
bc_assert(str_contains($rendered, 'Generate fresh dry run'), 'admin page offers an explicit dry run');
bc_assert($render_before === serialize([$GLOBALS['bc_posts'], $GLOBALS['bc_meta']]), 'rendering the admin page does not mutate posts');
$GLOBALS['bc_can_manage'] = false;
bc_throws(
    fn() => GSF_Reviewed_Duplicate_Cleanup_Admin::renderPage(),
    'Administrator permission',
    'renderPage rejects an unauthorized user'
);
$GLOBALS['bc_can_manage'] = true;

$valid = [GSF_Reviewed_Duplicate_Cleanup_Admin::class, 'validateBrowserRequest'];
bc_throws(fn() => $valid('dry-run', 'POST', false, true, false), 'permission', 'request validation rejects missing permission');
bc_throws(fn() => $valid('dry-run', 'GET', true, true, false), 'POST', 'request validation rejects non-POST requests');
bc_throws(fn() => $valid('dry-run', 'POST', true, false, false), 'security token', 'request validation rejects CSRF nonce failure');
bc_throws(fn() => $valid('apply', 'POST', true, true, false), 'confirmation phrase', 'request validation rejects missing destructive confirmation');
bc_assert($valid('apply', 'POST', true, true, true) === true, 'fully confirmed administrator POST is accepted');

$dry_source = [
    'operation' => 'dry-run',
    '_gsf_cleanup_nonce' => 'nonce:' . GSF_Reviewed_Duplicate_Cleanup_Admin::DRY_RUN_NONCE_ACTION,
];
$GLOBALS['bc_can_manage'] = false;
bc_throws(
    fn() => GSF_Reviewed_Duplicate_Cleanup_Admin::processBrowserPost($dry_source, 'POST'),
    'permission',
    'processBrowserPost rejects an unauthorized request'
);
$GLOBALS['bc_can_manage'] = true;
bc_throws(
    fn() => GSF_Reviewed_Duplicate_Cleanup_Admin::processBrowserPost($dry_source, 'GET'),
    'POST',
    'processBrowserPost rejects a non-POST request'
);
$bad_nonce_source = $dry_source;
$bad_nonce_source['_gsf_cleanup_nonce'] = 'nonce:wrong-action';
bc_throws(
    fn() => GSF_Reviewed_Duplicate_Cleanup_Admin::processBrowserPost($bad_nonce_source, 'POST'),
    'security token',
    'processBrowserPost verifies and rejects an invalid CSRF nonce'
);
$unconfirmed_apply = [
    'operation' => 'apply',
    'plan_token' => 'controller-ticket',
    '_gsf_cleanup_nonce' => 'nonce:' . GSF_Reviewed_Duplicate_Cleanup_Admin::APPLY_NONCE_PREFIX . 'controller-ticket',
];
bc_throws(
    fn() => GSF_Reviewed_Duplicate_Cleanup_Admin::processBrowserPost($unconfirmed_apply, 'POST'),
    'confirmation phrase',
    'processBrowserPost rejects apply without exact confirmation'
);
$controller_dry = GSF_Reviewed_Duplicate_Cleanup_Admin::processBrowserPost($dry_source, 'POST');
bc_assert(
    $controller_dry['dry_run']['mode'] === 'dry-run' && !empty($controller_dry['active_token']),
    'processBrowserPost executes a valid nonce-authenticated dry run'
);

bc_throws(
    fn() => GSF_Reviewed_Duplicate_Cleanup_Admin::getDownloadPayload('before', 7, false, true),
    'permission',
    'getDownloadPayload rejects unauthorized download'
);
bc_throws(
    fn() => GSF_Reviewed_Duplicate_Cleanup_Admin::getDownloadPayload('before', 7, true, false),
    'security token',
    'getDownloadPayload rejects invalid download nonce'
);
bc_throws(
    fn() => GSF_Reviewed_Duplicate_Cleanup_Admin::getDownloadPayload('unknown', 7, true, true),
    'Unknown',
    'getDownloadPayload rejects an unknown evidence phase'
);
$download_before = GSF_Reviewed_Duplicate_Cleanup_Admin::getDownloadPayload('before', 7, true, true);
bc_assert($download_before['wordpress']['raw_posts'] === 237, 'getDownloadPayload returns the requested current-user phase');
bc_throws(
    fn() => GSF_Reviewed_Duplicate_Cleanup_Admin::getDownloadPayload('before', 8, true, true),
    'no longer available',
    'getDownloadPayload isolates evidence per user'
);

$first_controller_token = $controller_dry['active_token'];
$second_controller_dry = GSF_Reviewed_Duplicate_Cleanup_Admin::processBrowserPost($dry_source, 'POST');
bc_assert($second_controller_dry['active_token'] !== $first_controller_token, 'a second dry run issues a fresh ticket');
bc_throws(
    fn() => GSF_Reviewed_Duplicate_Cleanup_Admin::performApply(7, $first_controller_token),
    'already used',
    'a second dry run invalidates the previous active ticket'
);

bc_reset_fixture();
$fixture_before = serialize([$GLOBALS['bc_posts'], $GLOBALS['bc_meta']]);
$dry = GSF_Reviewed_Duplicate_Cleanup_Admin::performDryRun(7);
bc_assert($fixture_before === serialize([$GLOBALS['bc_posts'], $GLOBALS['bc_meta']]), 'dry run is post-immutable');
bc_assert(count($dry['dry_run']['plan']['pairs']) === 5, 'dry run produces exactly five reviewed pairs');
bc_assert(count(array_unique(array_column($dry['dry_run']['plan']['pairs'], 'feed_id'))) === 5, 'dry-run plan contains each reviewed identity exactly once');
foreach ($dry['dry_run']['plan']['pairs'] as $pair) {
    bc_assert(count($pair['noncanonical_post_ids']) === 1 && $pair['action'] === 'delete', 'each reviewed pair has one exact deletion');
}
$plan = $dry['dry_run']['plan'];
$report = $dry['before'];

$unknown = $plan;
$unknown['pairs'][0]['feed_id'] = 'unknown-reviewed-id';
bc_throws(
    fn() => GSF_Reviewed_Duplicate_Cleanup_Admin::validateLivePlan($unknown, $report),
    'unknown or repeated',
    'unknown plan identity is rejected'
);
$tampered = $plan;
$tampered['pairs'][0]['noncanonical_post_ids'] = [999999];
bc_throws(
    fn() => GSF_Reviewed_Duplicate_Cleanup_Admin::validateLivePlan($tampered, $report),
    'Live post IDs changed',
    'tampered exact deletion ID is rejected'
);
$GLOBALS['bc_feed'][10]['id'] = 'changed-live-identity';
$changed = GSF_Reviewed_Duplicate_Cleanup_Admin::buildInventoryReport();
bc_throws(
    fn() => GSF_Reviewed_Duplicate_Cleanup_Admin::validateLivePlan($plan, $changed),
    'identity sets changed',
    'changed live identity set invalidates the dry-run plan'
);
$GLOBALS['bc_feed'][10]['id'] = $report['wordpress']['records'][10]['feed_id'];

$GLOBALS['bc_options'][GSF_Reviewed_Duplicate_Cleanup_Admin::LOCK_OPTION] = [
    'token' => 'other-owner',
    'expires_at' => time() + 900,
];
bc_throws(
    fn() => GSF_Reviewed_Duplicate_Cleanup_Admin::performDryRun(7),
    'already running',
    'lock contention blocks browser cleanup'
);
unset($GLOBALS['bc_options'][GSF_Reviewed_Duplicate_Cleanup_Admin::LOCK_OPTION]);

// MySQL named locks are connection-scoped: another connection blocks both entry paths.
$GLOBALS['bc_db_locks']['gsf_iconnect_member_sync'] = ['owner' => 2, 'depth' => 1];
bc_throws(
    fn() => GSF_Reviewed_Duplicate_Cleanup_Admin::performDryRun(7),
    'database lock is already held',
    'an advisory lock held by another connection blocks dry run'
);
unset($GLOBALS['bc_db_locks']['gsf_iconnect_member_sync']);
$advisory_apply_dry = GSF_Reviewed_Duplicate_Cleanup_Admin::performDryRun(7);
$GLOBALS['bc_db_locks']['gsf_iconnect_member_sync'] = ['owner' => 2, 'depth' => 1];
$advisory_apply = GSF_Reviewed_Duplicate_Cleanup_Admin::performApply(7, $advisory_apply_dry['active_token']);
bc_assert(
    str_contains($advisory_apply['apply']['error'], 'database lock is already held')
    && empty($GLOBALS['bc_deleted']),
    'an advisory lock held by another connection blocks apply before deletion'
);
unset($GLOBALS['bc_db_locks']['gsf_iconnect_member_sync']);

bc_reset_fixture();
$protected_dry = GSF_Reviewed_Duplicate_Cleanup_Admin::performDryRun(7);
$protected_token = $protected_dry['active_token'];
$GLOBALS['bc_hide_survivor'] = $protected_dry['dry_run']['plan']['pairs'][0]['survivor_post_id'];
$protected = GSF_Reviewed_Duplicate_Cleanup_Admin::performApply(7, $protected_token);
bc_assert(str_contains($protected['apply']['error'], 'Survivor protection'), 'apply rechecks and protects the published survivor');
bc_assert($GLOBALS['bc_deleted'] === [], 'survivor protection stops deletion before any post is changed');
bc_throws(
    fn() => GSF_Reviewed_Duplicate_Cleanup_Admin::performApply(7, $protected_token),
    'already used',
    'one-time plan ticket rejects replay after a failed apply'
);

bc_reset_fixture();
$lease_dry = GSF_Reviewed_Duplicate_Cleanup_Admin::performDryRun(7);
$lease_token = $lease_dry['active_token'];
$GLOBALS['bc_on_set_transient'] = function ($key, $evidence) {
    $attempts = $evidence['apply']['attempts'] ?? [];
    if (
        count($attempts) === 2
        && ($attempts[1]['result'] ?? '') === 'pending_delete'
    ) {
        $GLOBALS['bc_on_set_transient'] = null;
        $GLOBALS['bc_options'][GSF_Reviewed_Duplicate_Cleanup_Admin::LOCK_OPTION] = [
            'token' => 'replacement-owner',
            'expires_at' => time() + 900,
        ];
    }
};
$lease_result = GSF_Reviewed_Duplicate_Cleanup_Admin::performApply(7, $lease_token);
$lease_attempts = $lease_result['apply']['attempts'];
$durable_lease = $GLOBALS['bc_transients']['gsf_cleanup_evidence_7']['apply'];
bc_assert(count($GLOBALS['bc_deleted']) === 1, 'lease ownership loss between deletions aborts before the next delete');
bc_assert(
    count($lease_attempts) === 2
    && $lease_attempts[0]['result'] === 'deleted'
    && $lease_attempts[1]['result'] === 'blocked_before_delete',
    'lease loss records durable deleted and blocked-before-delete attempts'
);
bc_assert(
    $durable_lease['attempts'] === $lease_attempts
    && $durable_lease['applied'] === false
    && str_contains($durable_lease['error'], 'lease is not currently owned'),
    'partial lease-loss evidence survives in the per-user transient'
);

bc_reset_fixture();
$database_loss_dry = GSF_Reviewed_Duplicate_Cleanup_Admin::performDryRun(7);
$GLOBALS['bc_on_set_transient'] = function ($key, $evidence) {
    $attempts = $evidence['apply']['attempts'] ?? [];
    if (count($attempts) === 2 && ($attempts[1]['result'] ?? '') === 'pending_delete') {
        $GLOBALS['bc_on_set_transient'] = null;
        $GLOBALS['bc_db_locks']['gsf_iconnect_member_sync'] = ['owner' => 2, 'depth' => 1];
    }
};
$database_loss = GSF_Reviewed_Duplicate_Cleanup_Admin::performApply(7, $database_loss_dry['active_token']);
bc_assert(
    count($GLOBALS['bc_deleted']) === 1
    && $database_loss['apply']['attempts'][1]['result'] === 'blocked_before_delete',
    'loss of database-lock ownership blocks before the next deletion'
);
bc_assert(
    str_contains($database_loss['apply']['error'], 'lease is not currently owned')
    && $GLOBALS['bc_transients']['gsf_cleanup_evidence_7']['apply']['attempts'][1]['result'] === 'blocked_before_delete',
    'database-lock ownership loss retains durable blocked attempt evidence'
);
unset($GLOBALS['bc_db_locks']['gsf_iconnect_member_sync']);

bc_reset_fixture();
$failure_dry = GSF_Reviewed_Duplicate_Cleanup_Admin::performDryRun(7);
$GLOBALS['bc_delete_fail_on'] = 2;
$failure_result = GSF_Reviewed_Duplicate_Cleanup_Admin::performApply(7, $failure_dry['active_token']);
$failure_attempts = $failure_result['apply']['attempts'];
$durable_failure = $GLOBALS['bc_transients']['gsf_cleanup_evidence_7']['apply'];
bc_assert(count($GLOBALS['bc_deleted']) === 1, 'a WordPress deletion failure after one success prevents later deletions');
bc_assert(
    count($failure_attempts) === 2
    && $failure_attempts[0]['result'] === 'deleted'
    && $failure_attempts[1]['result'] === 'failed',
    'deletion failure persists both the successful and failed attempts'
);
bc_assert(
    $durable_failure['attempts'] === $failure_attempts
    && $durable_failure['applied'] === false
    && str_contains($durable_failure['error'], 'failed to permanently delete'),
    'deletion failure leaves durable evidence and applied false'
);
unset($GLOBALS['bc_transients']['gsf_cleanup_evidence_7']);
$failure_journal = $GLOBALS['bc_options']['gsf_cleanup_journal_7'] ?? [];
$failure_events = array_column($failure_journal['events'] ?? [], 'type');
bc_assert(
    in_array('delete_pending', $failure_events, true)
    && in_array('delete_succeeded', $failure_events, true)
    && in_array('delete_failed', $failure_events, true)
    && in_array('apply_error', $failure_events, true),
    'non-expiring apply journal retains pending, result, and error evidence after transient removal'
);

bc_reset_fixture();
$changed_between_dry = GSF_Reviewed_Duplicate_Cleanup_Admin::performDryRun(7);
$GLOBALS['bc_after_delete'] = function ($post_id, $delete_call) {
    if ($delete_call === 1) {
        $GLOBALS['bc_feed'][] = ['id' => 'unexpected-between-deletions', 'Account_Name' => 'Unexpected'];
    }
};
$changed_between = GSF_Reviewed_Duplicate_Cleanup_Admin::performApply(7, $changed_between_dry['active_token']);
bc_assert(count($GLOBALS['bc_deleted']) === 1, 'live identity change between deletions blocks all further deletion');
bc_assert(
    count($changed_between['apply']['attempts']) === 1
    && $changed_between['apply']['attempts'][0]['result'] === 'deleted'
    && str_contains($changed_between['apply']['error'], 'identity sets changed before deleting'),
    'per-deletion identity signature fence reports the changed live set'
);
bc_assert(
    $GLOBALS['bc_transients']['gsf_cleanup_evidence_7']['apply']['attempts'][0]['result'] === 'deleted'
    && $GLOBALS['bc_transients']['gsf_cleanup_evidence_7']['apply']['applied'] === false,
    'live-set abort retains durable partial deletion evidence'
);

bc_reset_fixture();
$competing_dry = GSF_Reviewed_Duplicate_Cleanup_Admin::performDryRun(7);
$GLOBALS['bc_competing_acquired'] = null;
$GLOBALS['bc_competing_option_token'] = null;
$GLOBALS['bc_on_before_delete'] = function () {
    $GLOBALS['bc_competing_option_token'] = $GLOBALS['bc_options'][GSF_Reviewed_Duplicate_Cleanup_Admin::LOCK_OPTION]['token'] ?? null;
    $original_connection = $GLOBALS['bc_db_connection'];
    $GLOBALS['bc_db_connection'] = 2;
    $GLOBALS['bc_competing_acquired'] = $GLOBALS['wpdb']->get_var([
        'query' => 'SELECT GET_LOCK(%s, %d)',
        'args' => ['gsf_iconnect_member_sync', 0],
    ]);
    $GLOBALS['bc_db_connection'] = $original_connection;
};
$competing_result = GSF_Reviewed_Duplicate_Cleanup_Admin::performApply(7, $competing_dry['active_token']);
bc_assert(
    $GLOBALS['bc_competing_acquired'] === '0'
    && $competing_result['apply']['applied'] === true
    && $GLOBALS['bc_competing_option_token'] !== null,
    'a competing connection cannot acquire the database lock or take over its asserted option lease'
);

bc_reset_fixture();
$final_mutation_dry = GSF_Reviewed_Duplicate_Cleanup_Admin::performDryRun(7);
$final_survivor_id = $final_mutation_dry['dry_run']['plan']['pairs'][4]['survivor_post_id'];
$GLOBALS['bc_after_delete'] = function ($post_id, $delete_call) use ($final_survivor_id) {
    if ($delete_call === 5) {
        $GLOBALS['bc_posts'][$final_survivor_id]->post_status = 'draft';
    }
};
$final_mutation = GSF_Reviewed_Duplicate_Cleanup_Admin::performApply(7, $final_mutation_dry['active_token']);
bc_assert(
    count($GLOBALS['bc_deleted']) === 5
    && $final_mutation['apply']['applied'] === true
    && $final_mutation['apply']['acceptance_passed'] === false,
    'final survivor mutation after fifth deletion makes acceptance fail'
);
bc_assert(
    $final_mutation['apply']['final_identity_snapshot_matched'] === false
    && str_contains($final_mutation['apply']['error'], 'final feed/WordPress survivor identity snapshot changed'),
    'final snapshot mismatch is recorded after a fifth-delete survivor mutation'
);

bc_reset_fixture();
$apply_dry = GSF_Reviewed_Duplicate_Cleanup_Admin::performDryRun(7);
$apply_token = $apply_dry['active_token'];
$expected_survivors = array_column($apply_dry['dry_run']['plan']['pairs'], 'survivor_post_id');
$expected_deletions = array_map(function ($pair) {
    return $pair['noncanonical_post_ids'][0];
}, $apply_dry['dry_run']['plan']['pairs']);
$result = GSF_Reviewed_Duplicate_Cleanup_Admin::performApply(7, $apply_token);
$deleted_ids = array_column($GLOBALS['bc_deleted'], 'id');
bc_assert(
    $deleted_ids === $expected_deletions,
    'apply permanently deletes exactly the five noncanonical IDs'
        . (!empty($result['apply']['error']) ? ' (apply error: ' . $result['apply']['error'] . ')' : '')
);
bc_assert(count($GLOBALS['bc_deleted']) === 5 && !in_array(false, array_column($GLOBALS['bc_deleted'], 'force'), true), 'all five deletions bypass trash permanently');
foreach ($expected_survivors as $survivor_id) {
    bc_assert(isset($GLOBALS['bc_posts'][$survivor_id]), 'every approved published survivor remains present');
}
bc_assert(count($result['apply']['attempts']) === 5, 'apply evidence logs all five deletion attempts');
bc_assert(
    count(array_filter($result['apply']['attempts'], fn($attempt) => $attempt['result'] === 'deleted')) === 5,
    'every deletion attempt is logged as deleted'
);
bc_assert($result['apply']['applied'] === true && $result['apply']['acceptance_passed'] === true, 'apply passes strict post-cleanup acceptance');

$after = $result['after'];
bc_assert($after['feed']['raw_records'] === 232 && $after['feed']['unique_nonblank_ids'] === 232, 'post-cleanup feed is exactly 232 unique identities');
bc_assert($after['wordpress']['raw_posts'] === 232 && $after['wordpress']['published_posts'] === 232, 'post-cleanup WordPress is exactly 232 published posts');
$strict_gates = [
    'configured_feed_has_232_unique_nonblank_ids',
    'wordpress_has_232_published_members',
    'no_duplicate_wordpress_stable_ids',
    'no_blank_wordpress_stable_ids',
    'no_stale_wordpress_stable_ids',
    'no_orphan_or_missing_stable_ids',
    'strict_post_cleanup_reconciliation_passed',
];
foreach ($strict_gates as $gate) {
    bc_assert($after['acceptance'][$gate]['passed'] === true, 'strict acceptance passes: ' . $gate);
}
bc_assert(
    empty($after['wordpress']['duplicate_ids'])
    && empty($after['wordpress']['blank_ids'])
    && empty($after['wordpress']['stale_ids'])
    && empty($after['wordpress']['missing_from_any_status'])
    && empty($after['wordpress']['missing_from_published']),
    'final inventory has no duplicate, blank, stale, orphan, or missing stable IDs'
);
bc_throws(
    fn() => GSF_Reviewed_Duplicate_Cleanup_Admin::performApply(7, $apply_token),
    'already used',
    'successfully applied ticket cannot be replayed'
);

echo "All browser cleanup regression checks passed.\n";