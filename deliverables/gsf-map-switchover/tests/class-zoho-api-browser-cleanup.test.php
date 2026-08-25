<?php

/*
 * Self-contained regression harness for the temporary browser cleanup.
 * Run with: php tests/class-zoho-api-browser-cleanup.test.php
 */

define('ABSPATH', __DIR__ . '/');

$GLOBALS['bc_hooks'] = [];
$GLOBALS['bc_submenus'] = [];
$GLOBALS['bc_options_pages'] = [];
$GLOBALS['bc_options'] = [];
$GLOBALS['bc_transients'] = [];
$GLOBALS['bc_posts'] = [];
$GLOBALS['bc_meta'] = [];
$GLOBALS['bc_feed'] = [];
$GLOBALS['bc_remote_mode'] = 'success';
$GLOBALS['bc_remote_status'] = 200;
$GLOBALS['bc_remote_body'] = null;
$GLOBALS['bc_remote_error'] = null;
$GLOBALS['bc_remote_requests'] = [];
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

class BrowserCleanupWpError
{
    private $message;

    public function __construct($message)
    {
        $this->message = $message;
    }

    public function get_error_message()
    {
        return $this->message;
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
function add_options_page(...$args)
{
    $GLOBALS['bc_options_pages'][] = $args;
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
function delete_transient($key)
{
    unset($GLOBALS['bc_transients'][$key]);
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
function wp_remote_get($url = '', $args = [])
{
    $GLOBALS['bc_remote_requests'][] = ['url' => $url, 'args' => $args];
    if ($GLOBALS['bc_remote_mode'] === 'network_error') {
        return new BrowserCleanupWpError($GLOBALS['bc_remote_error'] ?? 'simulated network failure');
    }
    $body = $GLOBALS['bc_remote_body'];
    if ($body === null) {
        $body = json_encode($GLOBALS['bc_feed']);
    }
    return ['response' => ['code' => $GLOBALS['bc_remote_status']], 'body' => $body];
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
    return func_get_arg(0) instanceof BrowserCleanupWpError;
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
function esc_url_raw($value)
{
    return filter_var((string) $value, FILTER_SANITIZE_URL);
}
function wp_parse_url($value)
{
    return parse_url((string) $value);
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
function add_query_arg($args, $url)
{
    return $url . (str_contains($url, '?') ? '&' : '?') . http_build_query($args);
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
    $GLOBALS['bc_remote_mode'] = 'success';
    $GLOBALS['bc_remote_status'] = 200;
    $GLOBALS['bc_remote_body'] = null;
    $GLOBALS['bc_remote_error'] = null;
    $GLOBALS['bc_remote_requests'] = [];
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
            $GLOBALS['bc_posts'][$copy_id] = bc_post($copy_id, 'publish', $name . ' reviewed copy');
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
bc_assert(isset($GLOBALS['bc_hooks']['admin_post_gsf_iconnect_feed_settings_save']), 'feed settings POST hook is registered');
bc_assert(isset($GLOBALS['bc_hooks']['admin_post_gsf_reviewed_duplicate_cleanup']), 'cleanup POST hook is registered');
bc_assert(isset($GLOBALS['bc_hooks']['admin_post_gsf_reviewed_duplicate_cleanup_download']), 'evidence download hook is registered');
GSF_Iconnect_Feed_Settings_Admin::registerMenu();
bc_assert(
    $GLOBALS['bc_options_pages'][0][2] === 'manage_options'
    && $GLOBALS['bc_options_pages'][0][3] === GSF_Iconnect_Feed_Settings_Admin::PAGE_SLUG,
    'feed settings page is restricted to administrators'
);
GSF_Reviewed_Duplicate_Cleanup_Admin::registerMenu();
bc_assert(
    $GLOBALS['bc_submenus'][0][0] === 'edit.php?post_type=gsf_member'
    && $GLOBALS['bc_submenus'][0][3] === 'manage_options',
    'cleanup page is an administrator member submenu'
);

bc_reset_fixture();
ob_start();
GSF_Iconnect_Feed_Settings_Admin::renderPage();
$settings_rendered = ob_get_clean();
bc_assert(
    str_contains($settings_rendered, 'GSF iConnect Feed')
    && str_contains($settings_rendered, 'https://iconnect.example')
    && str_contains($settings_rendered, 'An API key is configured')
    && !str_contains($settings_rendered, 'test-key'),
    'settings page shows the URL and key status without rendering the saved key'
);
$GLOBALS['bc_can_manage'] = false;
bc_throws(
    fn() => GSF_Iconnect_Feed_Settings_Admin::renderPage(),
    'Administrator permission',
    'feed settings page rejects an unauthorized user'
);
$GLOBALS['bc_can_manage'] = true;

$settings_source = [
    '_gsf_iconnect_settings_nonce' => 'nonce:' . GSF_Iconnect_Feed_Settings_Admin::NONCE_ACTION,
    'gsf_iconnect_base_url' => 'https://gfi.iconn.app/',
    'gsf_iconnect_api_key' => '',
    'operation' => 'save',
];
bc_throws(
    fn() => GSF_Iconnect_Feed_Settings_Admin::processSettingsPost($settings_source, 'GET'),
    'POST',
    'feed settings reject a non-POST request'
);
$bad_settings_nonce = $settings_source;
$bad_settings_nonce['_gsf_iconnect_settings_nonce'] = 'nonce:wrong-action';
bc_throws(
    fn() => GSF_Iconnect_Feed_Settings_Admin::processSettingsPost($bad_settings_nonce, 'POST'),
    'security token',
    'feed settings reject an invalid CSRF nonce'
);
$settings_saved = GSF_Iconnect_Feed_Settings_Admin::processSettingsPost($settings_source, 'POST');
bc_assert(
    $settings_saved['type'] === 'success'
    && $GLOBALS['bc_options']['gsf_iconnect_base_url'] === 'https://gfi.iconn.app'
    && $GLOBALS['bc_options']['gsf_iconnect_api_key'] === 'test-key',
    'saving settings normalizes the URL and preserves a write-only existing key'
);
$invalid_settings = $settings_source;
$invalid_settings['gsf_iconnect_base_url'] = 'http://iconnect.example/path?unsafe=1';
bc_throws(
    fn() => GSF_Iconnect_Feed_Settings_Admin::processSettingsPost($invalid_settings, 'POST'),
    'HTTPS iconn.app origin',
    'feed settings reject an insecure URL with an endpoint path'
);
$external_settings = $settings_source;
$external_settings['gsf_iconnect_base_url'] = 'https://example.com';
bc_throws(
    fn() => GSF_Iconnect_Feed_Settings_Admin::processSettingsPost($external_settings, 'POST'),
    'HTTPS iconn.app origin',
    'feed settings reject an external host that could receive the shared key'
);
$replacement_settings = $settings_source;
$replacement_settings['gsf_iconnect_base_url'] = 'https://iconn.app';
$replacement_settings['gsf_iconnect_api_key'] = 'replacement-key';
$replacement_settings['operation'] = 'save-and-test';
$tested_settings = GSF_Iconnect_Feed_Settings_Admin::processSettingsPost($replacement_settings, 'POST');
$last_remote_request = end($GLOBALS['bc_remote_requests']);
bc_assert(
    $tested_settings['type'] === 'success'
    && str_contains($tested_settings['message'], '232 records')
    && $last_remote_request['url'] === 'https://iconn.app/api/public/gsf-map/members'
    && $last_remote_request['args']['headers']['X-Api-Key'] === 'replacement-key',
    'save-and-test verifies the members endpoint with the newly saved key'
);
unset($GLOBALS['bc_options']['gsf_iconnect_api_key']);
bc_throws(
    fn() => GSF_Iconnect_Feed_Settings_Admin::processSettingsPost($settings_source, 'POST'),
    'Enter the API key',
    'first-time setup cannot save without an API key'
);

bc_reset_fixture();
$observed_report = GSF_Reviewed_Duplicate_Cleanup_Admin::buildInventoryReport();
bc_assert(
    $observed_report['wordpress']['raw_posts'] === 237
    && $observed_report['wordpress']['published_posts'] === 237
    && $observed_report['wordpress']['unique_nonblank_ids'] === 232
    && $observed_report['wordpress']['published_unique_nonblank_ids'] === 232,
    'observed before-state is 237 published posts representing 232 stable identities'
);
bc_assert(
    count($observed_report['wordpress']['duplicate_ids']) === 5
    && count($observed_report['wordpress']['published_duplicate_ids']) === 5
    && $observed_report['pre_cleanup_safe'] === true,
    'the exact five reviewed all-published pairs pass the pre-cleanup gate'
);
$render_before = serialize([$GLOBALS['bc_posts'], $GLOBALS['bc_meta']]);
ob_start();
GSF_Reviewed_Duplicate_Cleanup_Admin::renderPage();
$rendered = ob_get_clean();
bc_assert(str_contains($rendered, 'Live all-status reconciliation'), 'admin page renders the read-only live report');
bc_assert(str_contains($rendered, 'Generate fresh dry run'), 'admin page offers an explicit dry run');
bc_assert(
    str_contains($rendered, '237 raw published posts')
    && str_contains($rendered, '232 unique published stable identities'),
    'admin page distinguishes raw published posts from unique published identities'
);
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

bc_reset_fixture();
$candidate_ids = array_values(array_filter(array_keys($GLOBALS['bc_posts']), fn($post_id) => $post_id >= 10000));
$candidate_statuses = ['draft', 'publish', 'private', 'future', 'publish'];
foreach ($candidate_ids as $index => $candidate_id) {
    $GLOBALS['bc_posts'][$candidate_id]->post_status = $candidate_statuses[$index];
}
$mixed_report = GSF_Reviewed_Duplicate_Cleanup_Admin::buildInventoryReport();
bc_assert(
    $mixed_report['pre_cleanup_safe'] === true
    && $mixed_report['wordpress']['published_posts'] === 234
    && $mixed_report['wordpress']['published_unique_nonblank_ids'] === 232,
    'mixed candidate statuses pass when every reviewed pair still has one deterministic published survivor'
);
$mixed_dry = GSF_Reviewed_Duplicate_Cleanup_Admin::performDryRun(7);
$planned_candidate_statuses = array_map(
    fn($pair) => $pair['noncanonical'][0]['status'],
    $mixed_dry['dry_run']['plan']['pairs']
);
sort($planned_candidate_statuses, SORT_STRING);
$expected_candidate_statuses = $candidate_statuses;
sort($expected_candidate_statuses, SORT_STRING);
bc_assert(
    $planned_candidate_statuses === $expected_candidate_statuses,
    'dry run captures and fences each mixed-status candidate exactly'
);

bc_reset_fixture();
unset($GLOBALS['bc_options']['gsf_iconnect_base_url']);
$missing_config = GSF_Reviewed_Duplicate_Cleanup_Admin::buildInventoryReport();
bc_assert(
    $missing_config['feed']['available'] === false
    && $missing_config['feed']['failure_kind'] === 'missing_configuration'
    && str_contains($missing_config['feed']['source'], 'gsf_iconnect_base_url')
    && str_contains($missing_config['feed']['error'], 'Missing WordPress option: gsf_iconnect_base_url'),
    'missing feed configuration preserves its concrete source and error'
);
bc_assert(
    $missing_config['feed']['raw_records'] === null
    && $missing_config['wordpress']['stale_ids'] === null
    && $missing_config['wordpress']['missing_from_any_status'] === null
    && $missing_config['wordpress']['missing_from_published'] === null,
    'missing feed does not classify every WordPress post against an empty comparison set'
);
bc_assert(
    $missing_config['acceptance']['no_stale_wordpress_stable_ids']['available'] === false
    && $missing_config['acceptance']['no_stale_wordpress_stable_ids']['passed'] === false
    && $missing_config['pre_cleanup_safe'] === false,
    'feed-dependent gates are unavailable and cleanup remains blocked'
);
bc_throws(
    fn() => GSF_Reviewed_Duplicate_Cleanup_Admin::buildDeletionPlan($missing_config),
    'Missing WordPress option: gsf_iconnect_base_url',
    'dry-run plan reports the actual missing feed option'
);
ob_start();
GSF_Reviewed_Duplicate_Cleanup_Admin::renderPage();
$missing_rendered = ob_get_clean();
bc_assert(
    str_contains($missing_rendered, 'Configured iConnect feed reconciliation is unavailable')
    && str_contains($missing_rendered, 'gsf_iconnect_base_url')
    && str_contains($missing_rendered, 'Configure and test the iConnect feed')
    && str_contains($missing_rendered, GSF_Iconnect_Feed_Settings_Admin::PAGE_SLUG)
    && str_contains($missing_rendered, 'UNAVAILABLE')
    && !str_contains($missing_rendered, '237 stale WordPress records'),
    'admin page prominently explains missing feed configuration without false stale results'
);

bc_reset_fixture();
$GLOBALS['bc_remote_status'] = 401;
$GLOBALS['bc_remote_body'] = '{"error":"API key rejected"}';
$rejected_feed = GSF_Reviewed_Duplicate_Cleanup_Admin::buildInventoryReport();
bc_assert(
    $rejected_feed['feed']['failure_kind'] === 'http_error'
    && $rejected_feed['feed']['http_status'] === 401
    && str_contains($rejected_feed['feed']['error'], 'API key rejected')
    && str_contains($rejected_feed['feed']['source'], '/api/public/gsf-map/members'),
    'rejected feed request preserves HTTP status, endpoint, and response reason'
);

bc_reset_fixture();
$GLOBALS['bc_remote_status'] = 503;
$GLOBALS['bc_remote_body'] = '{"error":"GSF map API not configured"}';
$unavailable_feed = GSF_Reviewed_Duplicate_Cleanup_Admin::buildInventoryReport();
bc_assert(
    $unavailable_feed['feed']['failure_kind'] === 'http_error'
    && $unavailable_feed['feed']['http_status'] === 503
    && str_contains($unavailable_feed['feed']['error'], 'GSF map API not configured')
    && $unavailable_feed['pre_cleanup_safe'] === false,
    'unavailable endpoint reports its concrete 503 reason and blocks cleanup'
);

bc_reset_fixture();
$GLOBALS['bc_remote_mode'] = 'network_error';
$GLOBALS['bc_remote_error'] = 'Connection timed out after 60 seconds';
$network_feed = GSF_Reviewed_Duplicate_Cleanup_Admin::buildInventoryReport();
bc_assert(
    $network_feed['feed']['failure_kind'] === 'network_error'
    && str_contains($network_feed['feed']['error'], 'Connection timed out after 60 seconds')
    && $network_feed['wordpress']['stale_ids'] === null,
    'network failure is preserved and feed-dependent reconciliation stays unavailable'
);

bc_reset_fixture();
$network_dry = GSF_Reviewed_Duplicate_Cleanup_Admin::performDryRun(7);
$GLOBALS['bc_remote_mode'] = 'network_error';
$GLOBALS['bc_remote_error'] = 'Connection reset during apply validation';
$network_apply_report = GSF_Reviewed_Duplicate_Cleanup_Admin::buildInventoryReport();
bc_throws(
    fn() => GSF_Reviewed_Duplicate_Cleanup_Admin::validateLivePlan(
        $network_dry['dry_run']['plan'],
        $network_apply_report
    ),
    'Connection reset during apply validation',
    'apply validation blocks with the actual feed failure instead of an empty-feed comparison'
);

bc_reset_fixture();
$GLOBALS['bc_remote_body'] = '{"not":"a row array"';
$malformed_feed = GSF_Reviewed_Duplicate_Cleanup_Admin::buildInventoryReport();
bc_assert(
    $malformed_feed['feed']['failure_kind'] === 'malformed_json'
    && str_contains($malformed_feed['feed']['error'], 'malformed JSON')
    && $malformed_feed['wordpress']['missing_from_published'] === null,
    'malformed JSON is reported explicitly and does not produce missing-ID findings'
);

bc_reset_fixture();
$GLOBALS['bc_remote_body'] = '{"id":"object-not-list"}';
$invalid_shape_feed = GSF_Reviewed_Duplicate_Cleanup_Admin::buildInventoryReport();
bc_assert(
    $invalid_shape_feed['feed']['failure_kind'] === 'invalid_payload'
    && str_contains($invalid_shape_feed['feed']['error'], 'top-level value was not a row array'),
    'valid JSON with a malformed feed shape is rejected explicitly'
);

bc_reset_fixture();
$extra_post_id = 50000;
$extra_feed_id = (string) $GLOBALS['bc_meta'][1005]['zoho_id'];
$GLOBALS['bc_posts'][$extra_post_id] = bc_post($extra_post_id, 'publish', 'Unexpected extra duplicate');
$GLOBALS['bc_meta'][$extra_post_id] = ['zoho_id' => $extra_feed_id, 'last_sync' => '2026-08-25 11:00:00'];
$extra_duplicate = GSF_Reviewed_Duplicate_Cleanup_Admin::buildInventoryReport();
bc_assert(
    $extra_duplicate['pre_cleanup_safe'] === false
    && count($extra_duplicate['wordpress']['duplicate_ids']) === 6,
    'an additional unreviewed duplicate blocks plan generation'
);

bc_reset_fixture();
$GLOBALS['bc_meta'][1005]['zoho_id'] = '';
$blank_identity = GSF_Reviewed_Duplicate_Cleanup_Admin::buildInventoryReport();
bc_assert(
    $blank_identity['pre_cleanup_safe'] === false
    && count($blank_identity['wordpress']['blank_ids']) === 1
    && count($blank_identity['wordpress']['missing_from_any_status']) === 1,
    'blank and missing stable identities block plan generation'
);

bc_reset_fixture();
$GLOBALS['bc_meta'][1005]['zoho_id'] = 'unexpected-stale-id';
$stale_identity = GSF_Reviewed_Duplicate_Cleanup_Admin::buildInventoryReport();
bc_assert(
    $stale_identity['pre_cleanup_safe'] === false
    && count($stale_identity['wordpress']['stale_ids']) === 1
    && count($stale_identity['wordpress']['missing_from_published']) === 1,
    'stale/orphan and missing feed identities block plan generation'
);

bc_reset_fixture();
$first_reviewed = $observed_report['reviewed_identities'][0];
$ambiguous_post_id = 50001;
$GLOBALS['bc_posts'][$ambiguous_post_id] = bc_post($ambiguous_post_id, 'draft', 'Third reviewed copy');
$GLOBALS['bc_meta'][$ambiguous_post_id] = [
    'zoho_id' => $first_reviewed['feed_id'],
    'last_sync' => '2026-08-25 11:00:00',
];
$ambiguous_pair = GSF_Reviewed_Duplicate_Cleanup_Admin::buildInventoryReport();
bc_assert(
    $ambiguous_pair['pre_cleanup_safe'] === false
    && $ambiguous_pair['pre_cleanup_checks']['all_five_reviewed_identities_are_exact_pairs']['passed'] === false,
    'a reviewed identity with more than two records is ambiguous and blocked'
);

bc_reset_fixture();
$unpublished_pair_ids = array_column(
    GSF_Reviewed_Duplicate_Cleanup_Admin::buildInventoryReport()['reviewed_identities'][0]['records'],
    'wp_post_id'
);
foreach ($unpublished_pair_ids as $post_id) {
    $GLOBALS['bc_posts'][$post_id]->post_status = 'draft';
}
$unpublished_survivor = GSF_Reviewed_Duplicate_Cleanup_Admin::buildInventoryReport();
bc_assert(
    $unpublished_survivor['pre_cleanup_safe'] === false
    && $unpublished_survivor['wordpress']['published_unique_nonblank_ids'] === 231
    && $unpublished_survivor['pre_cleanup_checks']['all_five_reviewed_identities_are_exact_pairs']['passed'] === false,
    'a reviewed pair without a published survivor remains blocked'
);

bc_reset_fixture();
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