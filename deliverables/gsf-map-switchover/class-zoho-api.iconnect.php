<?php
/**
 * ============================================================================
 * iCONNECT SWITCH-OVER -- HANDOVER NOTES (2026-07-09)
 * ============================================================================
 * This file is the plugin's original ZohoAPI class with the Zoho CRM calls
 * repointed at the iConnect API. Every replaced block of original code has
 * been left in place but commented out between clearly marked
 *
 *     "ORIGINAL ZOHO CODE (disabled 2026-07-09)" / "END ORIGINAL ZOHO CODE"
 *
 * markers, and every new block is tagged [ICONNECT 2026-07-09] with a comment
 * explaining the change, so you can review exactly what changed and why.
 *
 * WHAT CHANGED
 *  - Members are now fetched from:   GET {base}/api/public/gsf-map/members
 *  - Countries are now fetched from: GET {base}/api/public/gsf-map/countries
 *  - Auth is a shared secret sent as an "X-Api-Key" header. There is no OAuth
 *    and no token refresh any more; the whole Zoho token machinery is
 *    commented out / no-opped.
 *  - Both endpoints return payloads byte-compatible with the old Zoho ones
 *    (same field names, same "id" values), already filtered to current
 *    members, in a single JSON array (no pagination and no "data"/"info"
 *    envelope).
 *  - Feed fields, getMembers() filters, and the gsf_zoho_countries option shape
 *    remain compatible. On 2026-08-25, member identity lookup and orchestration
 *    were hardened with all-status canonical matching and an expiring sync lock.
 *
 * CONFIGURATION (WordPress options -- set these BEFORE deploying)
 *   gsf_iconnect_base_url   e.g. https://your-iconnect-host  (no trailing /)
 *   gsf_iconnect_api_key    the shared secret; sent as the X-Api-Key header
 * e.g. via WP-CLI:
 *   wp option update gsf_iconnect_base_url 'https://...'
 *   wp option update gsf_iconnect_api_key '...'
 * If either option is missing the sync logs an ERROR and aborts (no fallback
 * to Zoho).
 *
 * ON THE iCONNECT SIDE
 *  - The env var GSF_MAP_API_SECRET must be set on the iConnect deployment;
 *    the endpoints return HTTP 503 until it is.
 *  - Responses are CDN-cached for 5 minutes (Cache-Control: max-age=300,
 *    stale-while-revalidate=600), so changes made in iConnect can take up to
 *    ~5 minutes to be visible to a sync.
 *  - A 401 from these endpoints means the API key is wrong. Unlike Zoho there
 *    is no token to refresh or clear -- the code now just logs and aborts.
 *
 * SECURITY -- PLEASE ACTION
 *  - The original file contained hard-coded Zoho OAuth credentials. Their
 *    literal values have been removed from this distributable, but credentials
 *    exposed in earlier copies must still be rotated / revoked in Zoho.
 * ============================================================================
 */
if (!class_exists('GSF_Member_Sync_Lock_Exception')) {
    class GSF_Member_Sync_Lock_Exception extends RuntimeException
    {
    }
}

/**
 * Zoho API integration class
 */
class ZohoAPI
{
    const MEMBER_SYNC_LOCK_OPTION = 'gsf_iconnect_member_sync_lock';
    const MEMBER_SYNC_DB_LOCK_NAME = 'gsf_iconnect_member_sync';
    const MEMBER_SYNC_LOCK_TTL = 900;
    const COUNTRY_DATA_VERSION_OPTION = 'gsf_iconnect_country_data_version';
    const COUNTRY_DATA_VERSION = 3;

    // [ICONNECT 2026-08-25] Literal legacy Zoho OAuth credentials were removed
    // from the distributable. iConnect settings are read from WordPress options.
    // ==================== ORIGINAL ZOHO CODE (disabled 2026-07-09) ====================
    // private $clientId = '[removed]';
    // private $clientSecret = '[removed]';
    // private $refreshToken = '[removed]';
    // ==================== END ORIGINAL ZOHO CODE ===================================
    // [ICONNECT 2026-07-09] $tokenExpiry / $accessToken are retained only so the
    // legacy debug helpers at the bottom of the file (getTokenStatus,
    // clearCachedTokens) keep compiling; they stay null and are never used for
    // requests any more.
    private $tokenExpiry = null;
    private $accessToken = null;
    private $lastSyncTime = null;
    private $lastCountrySyncTime = null;
    private $syncInterval = null; // Will be loaded from options
    private $countrySyncInterval = 86400; // 24 hours in seconds
    private $logger;

    public function __construct()
    {
        $this->logger = GSF_Logger::getInstance();
        $this->lastSyncTime = get_option('gsf_zoho_last_sync');
        $this->lastCountrySyncTime = get_option('gsf_zoho_last_country_sync');

        // Load sync interval from options (default to 1 hour)
        $this->syncInterval = get_option('gsf_sync_interval', 3600);

        // [ICONNECT 2026-07-09] No stored OAuth token to load any more -- auth is a
        // per-request X-Api-Key header read from the gsf_iconnect_api_key option.
        // ==================== ORIGINAL ZOHO CODE (disabled 2026-07-09) ====================
        // Kept for review -- safe to delete once the iConnect switch-over is verified.
        // -------------------------------------------------------------------------------
        // // Load stored token data
        // $this->accessToken = get_option('gsf_zoho_access_token');
        // $this->tokenExpiry = get_option('gsf_zoho_token_expiry', 0);
        // ==================== END ORIGINAL ZOHO CODE ===================================

        $this->logger->log('ZohoAPI initialized', 'INFO', [
            'lastSyncTime' => $this->lastSyncTime,
            'lastCountrySyncTime' => $this->lastCountrySyncTime,
            'tokenExpiry' => $this->tokenExpiry ? date('Y-m-d H:i:s', $this->tokenExpiry) : 'none'
        ]);
        // [ICONNECT 2026-07-09] No token refresh needed (maybeRefreshToken() is now a
        // no-op, see below).
        // ==================== ORIGINAL ZOHO CODE (disabled 2026-07-09) ====================
        // Kept for review -- safe to delete once the iConnect switch-over is verified.
        // -------------------------------------------------------------------------------
        // $this->maybeRefreshToken();
        // ==================== END ORIGINAL ZOHO CODE ===================================
    }

    // ==========================================================================
    // [ICONNECT 2026-07-09] New helpers for the iConnect switch-over.
    // The base URL and API key are read from WordPress options so that no
    // secrets are hard-coded in this file (unlike the original Zoho version).
    // ==========================================================================

    /**
     * [ICONNECT 2026-07-09] iConnect base URL, e.g. https://your-iconnect-host
     * (no trailing slash). Read from the gsf_iconnect_base_url option.
     */
    private function getIconnectBaseUrl()
    {
        $base = get_option('gsf_iconnect_base_url', '');
        return rtrim(is_string($base) ? trim($base) : '', '/');
    }

    /**
     * [ICONNECT 2026-07-09] Shared secret for the iConnect map endpoints, sent as
     * the X-Api-Key header. Read from the gsf_iconnect_api_key option.
     */
    private function getIconnectApiKey()
    {
        $key = get_option('gsf_iconnect_api_key', '');
        return is_string($key) ? trim($key) : '';
    }

    /**
     * [ICONNECT 2026-07-09] Shared GET helper for the two iConnect map endpoints.
     * Both endpoints return a bare JSON array (no Zoho-style data/info
     * envelope, no pagination). Returns the decoded array on success or null
     * on any failure; failures are logged so callers keep their existing
     * null/false handling.
     */
    private function fetchIconnectCollection($path, $context)
    {
        $base = $this->getIconnectBaseUrl();
        $key = $this->getIconnectApiKey();

        if ($base === '' || $key === '') {
            $this->logger->log('iConnect API not configured', 'ERROR', [
                'context' => $context,
                'missing_option' => $base === '' ? 'gsf_iconnect_base_url' : 'gsf_iconnect_api_key'
            ]);
            return null;
        }

        $url = $base . $path;

        $this->logger->log('Fetching from iConnect', 'DEBUG', [
            'context' => $context,
            'url' => $url
        ]);

        $response = wp_remote_get($url, [
            'headers' => [
                'X-Api-Key' => $key,
                'Accept' => 'application/json'
            ],
            'timeout' => 60
        ]);

        if (is_wp_error($response)) {
            $this->logger->log('iConnect API request failed', 'ERROR', [
                'context' => $context,
                'error' => $response->get_error_message()
            ]);
            return null;
        }

        $response_code = wp_remote_retrieve_response_code($response);
        $body = json_decode(wp_remote_retrieve_body($response), true);

        if ($response_code === 401) {
            // [ICONNECT 2026-07-09] Unlike Zoho, a 401 here means the shared API
            // key is wrong or has been rotated -- there is no token to refresh
            // or clear. Log and abort; fix the gsf_iconnect_api_key option.
            $this->logger->log('iConnect API rejected the API key (401) - check the gsf_iconnect_api_key option', 'ERROR', [
                'context' => $context
            ]);
            return null;
        }

        if ($response_code === 503) {
            // [ICONNECT 2026-07-09] The endpoints return 503 until the
            // GSF_MAP_API_SECRET env var is configured on the iConnect side.
            $this->logger->log('iConnect API not configured on the server (503) - GSF_MAP_API_SECRET not set on iConnect', 'ERROR', [
                'context' => $context
            ]);
            return null;
        }

        if ($response_code !== 200) {
            $this->logger->log('iConnect API returned non-200 status', 'ERROR', [
                'context' => $context,
                'response_code' => $response_code,
                'response' => $body
            ]);
            return null;
        }

        if (!is_array($body)) {
            $this->logger->log('iConnect API returned an unexpected (non-array) body', 'ERROR', [
                'context' => $context
            ]);
            return null;
        }

        return $body;
    }

    /**
     * Return every registered post status so stable feed identity is independent
     * of whether a member is currently published, drafted, private, pending,
     * scheduled, trashed, or held in a custom status.
     */
    private function getAllMemberPostStatuses()
    {
        $statuses = array_values(get_post_stati([], 'names'));
        return empty($statuses) ? ['publish', 'draft', 'pending', 'private', 'future', 'trash'] : $statuses;
    }

    /**
     * Resolve every WordPress post carrying a stable feed ID.
     */
    private function findMembersByFeedId($feed_id)
    {
        return get_posts([
            'post_type' => 'gsf_member',
            'meta_query' => [
                [
                    'key' => 'zoho_id',
                    'value' => $feed_id,
                    'compare' => '=',
                ]
            ],
            'posts_per_page' => -1,
            'post_status' => $this->getAllMemberPostStatuses(),
            'orderby' => 'ID',
            'order' => 'ASC',
            'suppress_filters' => false,
        ]);
    }

    /**
     * Pick one canonical post deterministically. Published posts win; ties and
     * all non-published sets use the oldest (lowest) post ID. The sync preserves
     * the selected post's status and never publishes it as a side effect.
     */
    private function selectCanonicalMember($matches)
    {
        if (empty($matches)) {
            return null;
        }

        usort($matches, function ($left, $right) {
            $left_published = $left->post_status === 'publish' ? 0 : 1;
            $right_published = $right->post_status === 'publish' ? 0 : 1;
            if ($left_published !== $right_published) {
                return $left_published <=> $right_published;
            }
            return ((int) $left->ID) <=> ((int) $right->ID);
        });

        return $matches[0];
    }

    private function describeMemberPost($post)
    {
        return [
            'wp_post_id' => (int) $post->ID,
            'status' => (string) $post->post_status,
            'name' => html_entity_decode((string) $post->post_title, ENT_QUOTES, 'UTF-8'),
            'created_at' => (string) $post->post_date,
            'modified_at' => (string) $post->post_modified,
            'last_sync' => (string) get_post_meta($post->ID, 'last_sync', true),
        ];
    }

    private function readMemberSyncLockRow()
    {
        global $wpdb;
        $raw = $wpdb->get_var($wpdb->prepare(
            "SELECT option_value FROM {$wpdb->options} WHERE option_name = %s LIMIT 1",
            self::MEMBER_SYNC_LOCK_OPTION
        ));
        if ($raw === null) {
            return null;
        }
        return [
            'raw' => (string) $raw,
            'value' => maybe_unserialize($raw),
        ];
    }

    private function clearMemberSyncLockCache()
    {
        wp_cache_delete(self::MEMBER_SYNC_LOCK_OPTION, 'options');
        wp_cache_delete('alloptions', 'options');
    }

    private function compareAndSwapMemberSyncLock($expected_raw, $replacement)
    {
        global $wpdb;
        $updated = $wpdb->query($wpdb->prepare(
            "UPDATE {$wpdb->options}
             SET option_value = %s
             WHERE option_name = %s AND option_value = %s",
            maybe_serialize($replacement),
            self::MEMBER_SYNC_LOCK_OPTION,
            $expected_raw
        ));
        if ($updated === 1) {
            $this->clearMemberSyncLockCache();
            return true;
        }
        return false;
    }

    private function acquireMemberDatabaseLock()
    {
        global $wpdb;
        $acquired = $wpdb->get_var($wpdb->prepare(
            'SELECT GET_LOCK(%s, %d)',
            self::MEMBER_SYNC_DB_LOCK_NAME,
            0
        ));
        return (string) $acquired === '1';
    }

    private function releaseMemberDatabaseLock()
    {
        global $wpdb;
        $wpdb->get_var($wpdb->prepare(
            'SELECT RELEASE_LOCK(%s)',
            self::MEMBER_SYNC_DB_LOCK_NAME
        ));
    }

    /**
     * Acquire an expiring lease. Initial acquisition uses add_option()'s unique
     * key; expired takeover is one compare-and-swap UPDATE, never read/delete.
     */
    private function acquireMemberSyncLock()
    {
        if (!$this->acquireMemberDatabaseLock()) {
            $row = $this->readMemberSyncLockRow();
            $current = is_array($row['value'] ?? null) ? $row['value'] : [];
            return [
                'acquired' => false,
                'busy_until' => (int) ($current['expires_at'] ?? 0),
                'acquired_at' => (int) ($current['acquired_at'] ?? 0),
                'database_lock_busy' => true,
            ];
        }
        try {
            $result = $this->acquireMemberSyncOptionLock();
            if (empty($result['acquired'])) {
                $this->releaseMemberDatabaseLock();
            }
            return $result;
        } catch (Throwable $error) {
            $this->releaseMemberDatabaseLock();
            throw $error;
        }
    }

    private function acquireMemberSyncOptionLock()
    {
        $now = time();
        $token = function_exists('wp_generate_uuid4')
            ? wp_generate_uuid4()
            : uniqid('gsf-member-sync-', true);
        $lock = [
            'token' => $token,
            'acquired_at' => $now,
            'expires_at' => $now + self::MEMBER_SYNC_LOCK_TTL,
        ];

        if (add_option(self::MEMBER_SYNC_LOCK_OPTION, $lock, '', false)) {
            return ['acquired' => true, 'lock' => $lock];
        }

        $row = $this->readMemberSyncLockRow();
        if ($row === null) {
            if (add_option(self::MEMBER_SYNC_LOCK_OPTION, $lock, '', false)) {
                return ['acquired' => true, 'lock' => $lock];
            }
            $row = $this->readMemberSyncLockRow();
        }

        $current = is_array($row['value'] ?? null) ? $row['value'] : [];
        if ((int) ($current['expires_at'] ?? 0) <= $now) {
            if ($this->compareAndSwapMemberSyncLock($row['raw'], $lock)) {
                return ['acquired' => true, 'lock' => $lock, 'recovered_expired_lock' => true];
            }
            $row = $this->readMemberSyncLockRow();
            $current = is_array($row['value'] ?? null) ? $row['value'] : [];
        }

        return [
            'acquired' => false,
            'busy_until' => is_array($current) ? (int) ($current['expires_at'] ?? 0) : 0,
            'acquired_at' => is_array($current) ? (int) ($current['acquired_at'] ?? 0) : 0,
        ];
    }

    /**
     * Renew the token-owned lease with compare-and-swap fencing. If another
     * request won expiry takeover, the stale owner fails before its next write.
     */
    private function renewMemberSyncLock(&$lock)
    {
        $row = $this->readMemberSyncLockRow();
        $current = is_array($row['value'] ?? null) ? $row['value'] : [];
        if (
            $row === null
            || !isset($current['token'])
            || !hash_equals((string) $current['token'], (string) ($lock['token'] ?? ''))
        ) {
            throw new GSF_Member_Sync_Lock_Exception('Member sync lease ownership was lost');
        }

        $replacement = $current;
        $replacement['expires_at'] = max(
            time() + self::MEMBER_SYNC_LOCK_TTL,
            (int) ($current['expires_at'] ?? 0) + 1
        );
        if (!$this->compareAndSwapMemberSyncLock($row['raw'], $replacement)) {
            throw new GSF_Member_Sync_Lock_Exception('Member sync lease renewal lost a concurrent race');
        }
        $lock = $replacement;
    }

    /**
     * Release with a token check and compare-and-delete. A stale owner cannot
     * delete a replacement lease acquired after expiry.
     */
    private function releaseMemberSyncLock($token)
    {
        global $wpdb;
        try {
            $row = $this->readMemberSyncLockRow();
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
                self::MEMBER_SYNC_LOCK_OPTION,
                $row['raw']
            ));
            if ($deleted === 1) {
                $this->clearMemberSyncLockCache();
            }
        } finally {
            $this->releaseMemberDatabaseLock();
        }
    }

    private function maybeRefreshToken()
    {
        // [ICONNECT 2026-07-09] No-op. iConnect auth is a static X-Api-Key header;
        // there is no OAuth token to refresh. The entire original refresh flow
        // (including the hard-coded credentials and token option writes) is
        // disabled below.
        return;

        // ==================== ORIGINAL ZOHO CODE (disabled 2026-07-09) ====================
        // Kept for review -- safe to delete once the iConnect switch-over is verified.
        // -------------------------------------------------------------------------------
        // $this->logger->log('Checking token status', 'DEBUG');
        //
        // // Add a 5-minute buffer before expiry to avoid edge cases
        // $buffer = 300; // 5 minutes
        //
        // if (!$this->accessToken || (time() > ($this->tokenExpiry - $buffer))) {
            // $this->logger->log('Token refresh required', 'INFO', [
                // 'current_time' => time(),
                // 'token_expiry' => $this->tokenExpiry,
                // 'time_until_expiry' => $this->tokenExpiry ? ($this->tokenExpiry - time()) : 'no_token'
            // ]);
        //
            // // Check for rate limiting - don't refresh more than once per minute
            // $last_refresh = get_option('gsf_zoho_last_token_refresh', 0);
            // if ($last_refresh && (time() - $last_refresh) < 60) {
                // $this->logger->log('Token refresh rate limited', 'WARNING', [
                    // 'seconds_since_last_refresh' => time() - $last_refresh
                // ]);
                // return;
            // }
        //
            // $response = wp_remote_post('https://accounts.zoho.eu/oauth/v2/token', [
                // 'body' => [
                    // 'client_id' => $this->clientId,
                    // 'client_secret' => $this->clientSecret,
                    // 'refresh_token' => $this->refreshToken,
                    // 'grant_type' => 'refresh_token'
                // ],
                // 'timeout' => 30
            // ]);
        //
            // if (is_wp_error($response)) {
                // $this->logger->log('Token refresh failed', 'ERROR', [
                    // 'error' => $response->get_error_message()
                // ]);
                // return;
            // }
        //
            // $body = json_decode(wp_remote_retrieve_body($response), true);
            // if (isset($body['access_token'])) {
                // $this->accessToken = $body['access_token'];
                // $this->tokenExpiry = time() + intval($body['expires_in']);
        //
                // // Store tokens persistently
                // update_option('gsf_zoho_access_token', $this->accessToken);
                // update_option('gsf_zoho_token_expiry', $this->tokenExpiry);
                // update_option('gsf_zoho_last_token_refresh', time());
        //
                // $this->logger->log('Token refreshed successfully', 'INFO', [
                    // 'expires_in' => $body['expires_in'],
                    // 'new_expiry' => date('Y-m-d H:i:s', $this->tokenExpiry)
                // ]);
            // } else {
                // $this->logger->log('Token refresh response invalid', 'ERROR', [
                    // 'response' => $body
                // ]);
            // }
        // } else {
            // $this->logger->log('Token still valid', 'DEBUG', [
                // 'expires_in' => $this->tokenExpiry - time() . ' seconds'
            // ]);
        // }
        // ==================== END ORIGINAL ZOHO CODE ===================================
    }

    private function syncMembersToWordPress($members, &$lock = null)
    {
        $this->logger->log('Starting member sync', 'INFO', [
            'memberCount' => count($members)
        ]);

        $sync_stats = [
            'created' => 0,
            'updated' => 0,
            'failed' => 0,
            'last_sync_updated' => 0,
            'duplicate_feed_ids' => [],
            'total_fetched' => count($members),
        ];

        foreach ($members as $member) {
            if (is_array($lock)) {
                $this->renewMemberSyncLock($lock);
            }
            $post_updated = false;
            $post_id = 0;
            $feed_id = trim((string) ($member['id'] ?? ''));
            if ($feed_id === '') {
                $sync_stats['failed']++;
                $this->logger->log('Member sync skipped because stable feed ID is blank', 'ERROR', [
                    'member' => $member['Account_Name'] ?? '',
                ]);
                continue;
            }

            $existing_member = $this->findMembersByFeedId($feed_id);
            $existing_post = $this->selectCanonicalMember($existing_member);

            if (count($existing_member) > 1) {
                $duplicate = [
                    'feed_id' => $feed_id,
                    'canonical' => $this->describeMemberPost($existing_post),
                    'noncanonical' => [],
                ];
                foreach ($existing_member as $match) {
                    if ((int) $match->ID !== (int) $existing_post->ID) {
                        $duplicate['noncanonical'][] = $this->describeMemberPost($match);
                    }
                }
                $sync_stats['duplicate_feed_ids'][] = $duplicate;
                $this->logger->log('Duplicate stable feed ID found; only canonical post will be updated', 'WARNING', $duplicate);
            }

            try {
                if ($existing_post === null) {
                    if (is_array($lock)) {
                        $this->renewMemberSyncLock($lock);
                    }
                    // New member - create as published initially
                    $member_data = [
                        'post_title' => $member['Account_Name'],
                        'post_type' => 'gsf_member',
                        'post_status' => 'publish',
                        'post_date' => current_time('mysql'),
                        'post_modified' => current_time('mysql'),
                    ];
                    $post_id = wp_insert_post($member_data, true);
                    if (!is_wp_error($post_id) && $post_id) {
                        $sync_stats['created']++;
                    } else {
                        $sync_stats['failed']++;
                        $this->logger->log('Member post insert failed', 'ERROR', [
                            'member_id' => $feed_id,
                            'error' => is_wp_error($post_id) ? $post_id->get_error_message() : 'wp_insert_post returned no post ID',
                        ]);
                        continue;
                    }
                } else {
                    // Check if existing member needs updating
                    $needs_update = false;

                    // Check if post title changed
                    if ($existing_post->post_title !== $member['Account_Name']) {
                        $needs_update = true;
                    }

                    if ($needs_update) {
                        if (is_array($lock)) {
                            $this->renewMemberSyncLock($lock);
                        }
                        // Update existing member - preserve current status
                        $member_data = [
                            'ID' => $existing_post->ID,
                            'post_title' => $member['Account_Name'],
                            'post_modified' => current_time('mysql'),
                            'post_status' => $existing_post->post_status
                        ];
                        $post_id = wp_update_post($member_data, true);
                        if (!is_wp_error($post_id) && $post_id) {
                            $post_updated = true;
                        } else {
                            $sync_stats['failed']++;
                            $this->logger->log('Member post update failed', 'ERROR', [
                                'member_id' => $feed_id,
                                'wp_post_id' => (int) $existing_post->ID,
                                'error' => is_wp_error($post_id) ? $post_id->get_error_message() : 'wp_update_post returned no post ID',
                            ]);
                            continue;
                        }
                    } else {
                        // No post update needed, but we still need the post ID for meta updates
                        $post_id = $existing_post->ID;
                    }
                }

                if ($post_id) {
                    // Format CEO name from first and last name if available
                    $ceo_name = '';
                    if (!empty($member['CEO_First_Name']) || !empty($member['CEO_Last_Name'])) {
                        $ceo_name = trim($member['CEO_First_Name'] . ' ' . $member['CEO_Last_Name']);
                    }

                    // Get stored country data with flags
                    $all_countries = get_option('gsf_zoho_countries', []);

                    // Filter countries of operation to only include those with
                    // Flag: Show. A normal sync overwrites legacy summary meta
                    // (for example "Multiple locations") with this exact list.
                    $countries_of_operation = $this->sanitizeCountriesOfOperation(
                        $member['Countries_of_Operation'] ?? [],
                        $all_countries
                    );

                    $new_meta_fields = [
                        'zoho_id' => $member['id'],
                        'organisation_name' => $member['Account_Name'],
                        'email' => $member['Email'],
                        'country' => $member['Location_of_HQ_Country'],
                        'countries_of_operation' => $countries_of_operation,
                        'organisation_type' => $member['Type_of_Organisation'],
                        'website' => $member['Website'],
                        'ceo_name' => $ceo_name,
                        'ceo_email' => $member['Email_of_CEO'],
                        'account_type' => $member['Account_Type'],
                        'lifecycle_status' => $member['Lifecycle_Status'],
                        'last_sync' => current_time('mysql'),
                        'Org_logo_URL' => $member['Org_logo_URL'] ?? '',
                        'Record_image_URL' => $member['Record_image_URL'] ?? '',
                        'Education_levels' => !empty($member['Education_levels']) && is_array($member['Education_levels']) ? $member['Education_levels'] : [],
                        'Do_programs_focus_on_key_emerging_existing_themes' => !empty($member['Do_programs_focus_on_key_emerging_existing_themes']) && is_array($member['Do_programs_focus_on_key_emerging_existing_themes']) ? $member['Do_programs_focus_on_key_emerging_existing_themes'] : [],
                        'Services_provided_to_partner_schools' => !empty($member['Services_provided_to_partner_schools']) && is_array($member['Services_provided_to_partner_schools']) ? $member['Services_provided_to_partner_schools'] : []
                    ];

                    // For existing members, check if meta fields actually changed before updating
                    $meta_updated = false;
                    if ($existing_post !== null) {
                        foreach ($new_meta_fields as $key => $new_value) {
                            // Skip last_sync from change detection (it always changes)
                            if ($key === 'last_sync') {
                                update_post_meta($post_id, $key, $new_value);
                                $sync_stats['last_sync_updated']++;
                                continue;
                            }

                            $existing_value = get_post_meta($post_id, $key, true);

                            // Normalize empty values for comparison
                            $new_value_normalized = $new_value === null ? '' : $new_value;
                            $existing_value_normalized = $existing_value === null ? '' : $existing_value;

                            // Handle array comparison properly
                            if (is_array($new_value_normalized) && is_array($existing_value_normalized)) {
                                // Sort arrays to ensure consistent comparison
                                sort($new_value_normalized);
                                sort($existing_value_normalized);

                                if ($new_value_normalized !== $existing_value_normalized) {
                                    update_post_meta($post_id, $key, $new_value);
                                    if (
                                        $key === 'countries_of_operation'
                                        && get_post_meta($post_id, $key, true) !== $new_value
                                    ) {
                                        throw new RuntimeException('Failed to persist countries_of_operation metadata');
                                    }
                                    $meta_updated = true;
                                    $this->logger->log('Meta field changed', 'DEBUG', [
                                        'member_id' => $member['id'],
                                        'field' => $key,
                                        'old' => $existing_value_normalized,
                                        'new' => $new_value_normalized
                                    ]);
                                }
                            } elseif ($existing_value_normalized !== $new_value_normalized) {
                                update_post_meta($post_id, $key, $new_value);
                                $meta_updated = true;
                                $this->logger->log('Meta field changed', 'DEBUG', [
                                    'member_id' => $member['id'],
                                    'field' => $key,
                                    'old' => $existing_value_normalized,
                                    'new' => $new_value_normalized
                                ]);
                            }
                        }

                        // If meta was updated but post wasn't, count it as an update
                        if ($meta_updated && !$post_updated) {
                            $sync_stats['updated']++;
                        } elseif ($post_updated) {
                            $sync_stats['updated']++;
                        }
                    } else {
                        // New member - update all meta fields
                        foreach ($new_meta_fields as $key => $value) {
                            update_post_meta($post_id, $key, $value);
                            if (
                                $key === 'countries_of_operation'
                                && get_post_meta($post_id, $key, true) !== $value
                            ) {
                                throw new RuntimeException('Failed to persist countries_of_operation metadata');
                            }
                        }
                        $sync_stats['last_sync_updated']++;
                    }
                }
            } catch (Throwable $e) {
                if ($e instanceof GSF_Member_Sync_Lock_Exception) {
                    throw $e;
                }
                $sync_stats['failed']++;
                $this->logger->log('Member sync failed', 'ERROR', [
                    'member' => $member['Account_Name'] ?? '',
                    'error' => $e->getMessage()
                ]);
            }
        }

        if (is_array($lock)) {
            $this->renewMemberSyncLock($lock);
        }

        // Update global sync timestamp
        update_option('gsf_zoho_last_sync', time());
        $this->lastSyncTime = time();
        gsf_clear_community_stats_cache();

        // Store sync stats for retrieval by other parts of the system
        update_option('gsf_last_sync_stats', $sync_stats);

        $this->logger->log('Member sync completed', 'INFO', $sync_stats);

        return $sync_stats;
    }

    public function getMembers($page = 1, $perPage = 200, $filters = [], $forceSync = false)
    {
        $this->logger->log('Fetching members', 'INFO', [
            'page' => $page,
            'perPage' => $perPage,
            'filters' => $filters,
            'forceSync' => $forceSync
        ]);

        // Enhanced rate limiting logic
        $shouldSync = false;
        $sync_result = [
            'status' => 'not_required',
            'reason' => 'interval_not_elapsed',
            'deleted_count' => 0,
        ];
        if ($forceSync) {
            // For manual syncs, check if we haven't synced in the last 30 seconds to prevent spam
            $last_manual_sync = get_option('gsf_zoho_last_manual_sync', 0);
            if (time() - $last_manual_sync > 30) {
                $shouldSync = true;
                $this->logger->log('Manual sync allowed', 'INFO', [
                    'seconds_since_last_manual' => time() - $last_manual_sync
                ]);
            } else {
                $sync_result = [
                    'status' => 'skipped',
                    'reason' => 'manual_rate_limited',
                    'retry_after_seconds' => 30 - (time() - $last_manual_sync),
                    'deleted_count' => 0,
                ];
                $this->logger->log('Manual sync rate limited', 'WARNING', [
                    'seconds_since_last_manual' => time() - $last_manual_sync,
                    'wait_seconds' => 30 - (time() - $last_manual_sync)
                ]);
            }
        } else {
            // A country-data version bump forces one successful refresh even
            // when the normal hourly interval has not elapsed.
            $country_data_upgrade_required = $this->isCountryDataUpgradeRequired();
            $shouldSync = $country_data_upgrade_required
                || !$this->lastSyncTime
                || (time() - $this->lastSyncTime) > $this->syncInterval;
            if ($country_data_upgrade_required) {
                $sync_result['reason'] = 'country_data_upgrade_required';
            }
        }

        $deleted_count = 0;
        if ($shouldSync) {
            $sync_result = $this->syncWithZoho();
            $deleted_count = (int) ($sync_result['deleted_count'] ?? 0);
            if ($forceSync && ($sync_result['status'] ?? '') === 'completed') {
                update_option('gsf_zoho_last_manual_sync', time());
            }
        } else {
            $this->logger->log('Sync not required', 'DEBUG', [
                'last_sync_time' => $this->lastSyncTime ? date('Y-m-d H:i:s', $this->lastSyncTime) : 'never',
                'time_since_sync' => $this->lastSyncTime ? time() - $this->lastSyncTime : 'never',
                'sync_interval' => $this->syncInterval
            ]);
        }

        // Query WordPress for members
        $query_args = [
            'post_type' => 'gsf_member',
            'posts_per_page' => $perPage,
            'paged' => $page,
            'post_status' => 'publish',
            'orderby' => 'title',
            'order' => 'ASC',
            'meta_query' => []
        ];

        // Apply filters
        if (!empty($filters['search'])) {
            $query_args['s'] = $filters['search'];
        }

        if (!empty($filters['country'])) {
            // ONLY search in countries_of_operation, not in the primary country field
            $query_args['meta_query'][] = [
                'key' => 'countries_of_operation',
                'value' => serialize($filters['country']),
                'compare' => 'LIKE'
            ];
        }

        if (!empty($filters['organization_type'])) {
            $types = array_map('trim', explode(',', $filters['organization_type']));
            // Prepend `Member - ` to each type
            $types = array_map(function ($type) {
                return trim('Member – ' . $type);
            }, $types);

            $query_args['meta_query'][] = [
                'key' => 'account_type',
                'value' => $types,
                'compare' => 'IN'
            ];
        }

        if (!empty($filters['focus_areas'])) {
            $focus_areas = array_map('trim', explode(',', $filters['focus_areas'])); //arr of l_c fas

            $meta_query = ['relation' => 'OR'];

            foreach ($focus_areas as $fa) {
                $human_value = ucwords(str_replace('_', ' ', $fa));

                $meta_query[] = [
                    'key' => 'Do_programs_focus_on_key_emerging_existing_themes',
                    'value' => $human_value,
                    'compare' => 'LIKE'
                ];

                $meta_query[] = [
                    'key' => 'Services_provided_to_partner_schools',
                    'value' => $human_value,
                    'compare' => 'LIKE'
                ];
            }

            $query_args['meta_query'][] = $meta_query;
        }


        if (count($query_args['meta_query']) > 1) {
            $query_args['meta_query']['relation'] = 'AND';
        }

        $query = new WP_Query($query_args);
        $members = [];

        if ($query->have_posts()) {
            while ($query->have_posts()) {
                $query->the_post();
                // Keep stale summary sentinels out of the public response even
                // if a request arrives while the one-time refresh is running.
                $countries_of_operation = $this->sanitizeCountriesOfOperation(
                    get_post_meta(get_the_ID(), 'countries_of_operation', true)
                );

                $members[] = [
                    'Organisation_name' => html_entity_decode(get_the_title(), ENT_QUOTES, 'UTF-8'),  // Used by the frontend
                    'Account_Name' => get_the_title(),       // Used for Zoho sync
                    'Country' => get_post_meta(get_the_ID(), 'country', true),
                    'Type_of_Organisation' => get_post_meta(get_the_ID(), 'organisation_type', true),
                    'Email' => get_post_meta(get_the_ID(), 'email', true),
                    'Website' => get_post_meta(get_the_ID(), 'website', true),
                    'Countries_of_Operation' => $countries_of_operation,
                    'Account_Type' => get_post_meta(get_the_ID(), 'account_type', true),
                    'Org_logo_URL' => get_post_meta(get_the_ID(), 'Org_logo_URL', true),
                    'Record_image_URL' => get_post_meta(get_the_ID(), 'Record_image_URL', true),
                    'Education_levels' => get_post_meta(get_the_ID(), 'Education_levels', true),
                    'Do_programs_focus_on_key_emerging_existing_themes' => get_post_meta(get_the_ID(), 'Do_programs_focus_on_key_emerging_existing_themes', true),
                    'Services_provided_to_partner_schools' => get_post_meta(get_the_ID(), 'Services_provided_to_partner_schools', true)
                ];
            }
            wp_reset_postdata();
        }

        return [
            'members' => $members,
            'total' => $query->found_posts,
            'deleted_count' => isset($deleted_count) ? $deleted_count : 0,
            'sync_result' => $sync_result,
            'sync_stats' => get_option('gsf_last_sync_stats', [
                'created' => 0,
                'updated' => 0,
                'failed' => 0
            ])
        ];
    }

    /**
     * Normalise country names that Zoho stores inconsistently against the Countries1 module.
     * Shares the same override list used by the map (see gsf_get_country_name_overrides())
     * so sync-time filtering and map counting never drift out of sync.
     */
    private function normaliseCountryName($name)
    {
        return gsf_normalize_country_name($name);
    }

    /**
     * Return individual country names only.
     *
     * When the country option is supplied (during ingestion), retain only
     * countries enabled for the map. Without it (public response), preserve the
     * already-filtered stored list while stripping stale summary sentinels.
     */
    private function sanitizeCountriesOfOperation($countries, $all_countries = null)
    {
        if (!is_array($countries)) {
            return [];
        }

        $sanitized = [];
        foreach ($countries as $country_name) {
            $country_name = trim((string) $this->normaliseCountryName($country_name));
            if ($country_name === '' || strcasecmp($country_name, 'Multiple locations') === 0) {
                continue;
            }
            if (
                is_array($all_countries)
                && (
                    !isset($all_countries[$country_name]['flag'])
                    || strtolower((string) $all_countries[$country_name]['flag']) !== 'show'
                )
            ) {
                continue;
            }
            if (!in_array($country_name, $sanitized, true)) {
                $sanitized[] = $country_name;
            }
        }

        return $sanitized;
    }

    private function isCountryDataUpgradeRequired()
    {
        return (int) get_option(self::COUNTRY_DATA_VERSION_OPTION, 0) < self::COUNTRY_DATA_VERSION;
    }

    // [ICONNECT 2026-07-09] getMemberSearchCriteria() built the Zoho search
    // criteria string. The iConnect /api/public/gsf-map/members endpoint
    // already returns ONLY current members of the two member account types, so
    // this filtering now happens server-side in iConnect and the method is no
    // longer called from anywhere.
    // ==================== ORIGINAL ZOHO CODE (disabled 2026-07-09) ====================
    // Kept for review -- safe to delete once the iConnect switch-over is verified.
    // -------------------------------------------------------------------------------
    // /**
     // * Zoho Accounts search criteria for member sync.
     // * Lifecycle applies to both member account types (grouped OR, not the old bug
     // * where School operators bypassed lifecycle).
     // */
    // private function getMemberSearchCriteria()
    // {
        // $lifecycle_statuses = apply_filters('gsf_member_sync_lifecycle_statuses', ['Current']);
        // $account_type_criteria = '((Account_Type:equals:Member – Education Support Organisations)or(Account_Type:equals:Member – School and ECED Operators))';
    //
        // if (count($lifecycle_statuses) === 1) {
            // $lifecycle_criteria = '(Lifecycle_Status:equals:' . $lifecycle_statuses[0] . ')';
        // } else {
            // $lifecycle_criteria = '(Lifecycle_Status:in:' . implode(',', $lifecycle_statuses) . ')';
        // }
    //
        // return '(' . $lifecycle_criteria . 'and' . $account_type_criteria . ')';
    // }
    // ==================== END ORIGINAL ZOHO CODE ===================================

    /**
     * Fetch all member accounts from Zoho using paginated search.
     *
     * @return array{members: array, pages_fetched: int}|null Null on API failure.
     */
    // [ICONNECT 2026-07-09] Method name kept so no callers change. Members now
    // come from iConnect instead of Zoho CRM.
    private function fetchAllMembersFromZoho()
    {
        // [ICONNECT 2026-07-09] GET {base}/api/public/gsf-map/members with an
        // X-Api-Key header. The endpoint returns a bare JSON array of member
        // records byte-compatible with the Zoho Accounts payload (same field
        // names, same 'id' values) and already filtered to current members, so
        // the Zoho criteria search, the pagination loop and the
        // $body['data'] / $body['info']['more_records'] handling below are no
        // longer needed. The return shape ({members, pages_fetched}) is
        // unchanged so syncWithZoho() and countZohoMembers() are untouched.
        $members = $this->fetchIconnectCollection('/api/public/gsf-map/members', 'members');
        if ($members === null) {
            return null;
        }

        // Preserve the original de-duplication-by-id behaviour.
        $allMembersById = [];
        foreach ($members as $member) {
            if (!empty($member['id'])) {
                $allMembersById[$member['id']] = $member;
            }
        }

        if (empty($allMembersById)) {
            $this->logger->log('No members returned from iConnect', 'WARNING');
            return null;
        }

        return [
            'members' => array_values($allMembersById),
            'pages_fetched' => 1, // iConnect returns everything in one response
        ];

        // ==================== ORIGINAL ZOHO CODE (disabled 2026-07-09) ====================
        // Kept for review -- safe to delete once the iConnect switch-over is verified.
        // -------------------------------------------------------------------------------
        // $criteria = $this->getMemberSearchCriteria();
        // $baseUrl = 'https://www.zohoapis.eu/crm/v2/Accounts/search';
        // $perPage = 200;
        // $page = 1;
        // $hasMorePages = true;
        // $allMembersById = [];
        //
        // while ($hasMorePages) {
            // $queryArgs = http_build_query([
                // 'criteria' => $criteria,
                // 'page' => $page,
                // 'per_page' => $perPage
            // ]);
            // $url = $baseUrl . '?' . $queryArgs;
        //
            // $this->logger->log('Fetching members page from Zoho', 'DEBUG', [
                // 'page' => $page,
                // 'per_page' => $perPage,
                // 'url' => $url
            // ]);
        //
            // $response = wp_remote_get($url, [
                // 'headers' => [
                    // 'Authorization' => 'Zoho-oauthtoken ' . $this->accessToken,
                    // 'Content-Type' => 'application/json'
                // ],
                // 'timeout' => 30
            // ]);
        //
            // if (is_wp_error($response)) {
                // $this->logger->log('Zoho API request failed', 'ERROR', [
                    // 'error' => $response->get_error_message(),
                    // 'page' => $page
                // ]);
                // return null;
            // }
        //
            // $response_code = wp_remote_retrieve_response_code($response);
            // $body = json_decode(wp_remote_retrieve_body($response), true);
        //
            // if ($response_code === 429) {
                // $this->logger->log('Zoho API rate limit exceeded', 'ERROR', [
                    // 'response_code' => $response_code,
                    // 'response' => $body,
                    // 'page' => $page
                // ]);
                // return null;
            // } elseif ($response_code === 401) {
                // $this->logger->log('Zoho API authentication failed, clearing cached tokens', 'ERROR', [
                    // 'response_code' => $response_code,
                    // 'page' => $page
                // ]);
                // delete_option('gsf_zoho_access_token');
                // delete_option('gsf_zoho_token_expiry');
                // $this->accessToken = null;
                // $this->tokenExpiry = 0;
                // $this->maybeRefreshToken();
                // return null;
            // } elseif ($response_code !== 200) {
                // $this->logger->log('Zoho API returned non-200 status', 'ERROR', [
                    // 'response_code' => $response_code,
                    // 'response' => $body,
                    // 'page' => $page
                // ]);
                // return null;
            // }
        //
            // if (isset($body['data']) && is_array($body['data']) && count($body['data']) > 0) {
                // foreach ($body['data'] as $member) {
                    // if (!empty($member['id'])) {
                        // $allMembersById[$member['id']] = $member;
                    // }
                // }
        //
                // if (isset($body['info']['more_records'])) {
                    // if ($body['info']['more_records']) {
                        // $page++;
                    // } else {
                        // $hasMorePages = false;
                    // }
                // } elseif (count($body['data']) < $perPage) {
                    // $hasMorePages = false;
                // } else {
                    // $page++;
                // }
            // } else {
                // $hasMorePages = false;
        //
                // if ($page === 1) {
                    // $this->logger->log('No members returned from Zoho', 'WARNING', [
                        // 'response' => $body
                    // ]);
                    // return null;
                // }
            // }
        // }
        //
        // return [
            // 'members' => array_values($allMembersById),
            // 'pages_fetched' => $page,
        // ];
        // ==================== END ORIGINAL ZOHO CODE ===================================
    }

    private function syncWithZoho()
    {
        $lock_result = $this->acquireMemberSyncLock();
        if (!$lock_result['acquired']) {
            $result = [
                'status' => 'busy',
                'reason' => 'member_sync_already_running',
                'deleted_count' => 0,
                'busy_until' => $lock_result['busy_until'],
                'retry_after_seconds' => max(1, $lock_result['busy_until'] - time()),
            ];
            update_option('gsf_last_sync_result', $result);
            $this->logger->log('Member sync skipped because another sync holds the lock', 'WARNING', $result);
            return $result;
        }

        $lock = $lock_result['lock'];
        $started_at = time();
        $this->logger->log('Sync lock acquired; fetching all members from iConnect', 'INFO', [
            'lock_expires_at' => $lock['expires_at'],
            'recovered_expired_lock' => !empty($lock_result['recovered_expired_lock']),
        ]);

        try {
        // [ICONNECT 2026-07-09] No token refresh needed for iConnect (no-op anyway).
        // ==================== ORIGINAL ZOHO CODE (disabled 2026-07-09) ====================
        // Kept for review -- safe to delete once the iConnect switch-over is verified.
        // -------------------------------------------------------------------------------
        // $this->maybeRefreshToken();
        // ==================== END ORIGINAL ZOHO CODE ===================================

        // Check if we need to sync countries
        $shouldSyncCountries = $this->isCountryDataUpgradeRequired()
            || !$this->lastCountrySyncTime
            || (time() - $this->lastCountrySyncTime) > $this->countrySyncInterval;
        if ($shouldSyncCountries) {
            if (!$this->syncCountriesFromZoho()) {
                $result = [
                    'status' => 'failed',
                    'reason' => 'country_fetch_failed',
                    'deleted_count' => 0,
                ];
                update_option('gsf_last_sync_result', $result);
                return $result;
            }
        }
        $this->renewMemberSyncLock($lock);

        $fetchResult = $this->fetchAllMembersFromZoho();
        if ($fetchResult === null) {
            $result = [
                'status' => 'failed',
                'reason' => 'member_fetch_failed',
                'deleted_count' => 0,
            ];
            update_option('gsf_last_sync_result', $result);
            return $result;
        }
        $this->renewMemberSyncLock($lock);

        $allMembers = $fetchResult['members'];
        $pagesFetched = $fetchResult['pages_fetched'];

        if (empty($allMembers)) {
            $this->logger->log('No members to sync from Zoho', 'WARNING');
            $result = [
                'status' => 'failed',
                'reason' => 'empty_member_feed',
                'deleted_count' => 0,
            ];
            update_option('gsf_last_sync_result', $result);
            return $result;
        }

        $current_zoho_ids = array_map(function ($member) {
            return $member['id'];
        }, $allMembers);
        $this->renewMemberSyncLock($lock);

        $stale_members = get_posts([
            'post_type' => 'gsf_member',
            'post_status' => 'publish',
            'posts_per_page' => -1,
            'fields' => 'ids',
            'meta_query' => [
                [
                    'key' => 'zoho_id',
                    'value' => $current_zoho_ids,
                    'compare' => 'NOT IN'
                ]
            ]
        ]);

        $orphan_members = get_posts([
            'post_type' => 'gsf_member',
            'post_status' => 'publish',
            'posts_per_page' => -1,
            'fields' => 'ids',
            'meta_query' => [
                'relation' => 'OR',
                [
                    'key' => 'zoho_id',
                    'compare' => 'NOT EXISTS',
                ],
                [
                    'key' => 'zoho_id',
                    'value' => '',
                    'compare' => '=',
                ],
            ],
        ]);

        $posts_to_delete = array_unique(array_merge($stale_members, $orphan_members));

        $deleted_count = 0;
        foreach ($posts_to_delete as $post_id) {
            $this->renewMemberSyncLock($lock);
            wp_delete_post($post_id, true);
            $deleted_count++;
        }

        if ($deleted_count > 0) {
            $this->logger->log('Removed stale or orphan member records', 'INFO', [
                'deleted_count' => $deleted_count,
                'stale_count' => count($stale_members),
                'orphan_count' => count($orphan_members),
            ]);
        }

        $sync_stats = $this->syncMembersToWordPress($allMembers, $lock);
        return $this->finalizeMemberSyncResult(
            $sync_stats,
            count($allMembers),
            $pagesFetched,
            $deleted_count,
            $started_at
        );
        } catch (Throwable $e) {
            $result = [
                'status' => 'failed',
                'reason' => $e instanceof GSF_Member_Sync_Lock_Exception
                    ? 'member_sync_lock_lost'
                    : 'unexpected_exception',
                'message' => $e->getMessage(),
                'deleted_count' => 0,
            ];
            update_option('gsf_last_sync_result', $result);
            $this->logger->log('Member sync failed unexpectedly', 'ERROR', $result);
            return $result;
        } finally {
            $this->releaseMemberSyncLock($lock['token']);
        }
    }

    private function finalizeMemberSyncResult($sync_stats, $total_members, $pages_fetched, $deleted_count, $started_at)
    {
        $failed = (int) ($sync_stats['failed'] ?? 0);
        if ($failed > 0) {
            $result = [
                'status' => 'failed',
                'reason' => 'member_metadata_refresh_failed',
                'failed_members' => $failed,
                'total_members_fetched' => $total_members,
                'pages_fetched' => $pages_fetched,
                'deleted_count' => $deleted_count,
                'duplicate_feed_ids' => $sync_stats['duplicate_feed_ids'] ?? [],
                'started_at' => $started_at,
                'completed_at' => time(),
            ];
            update_option('gsf_last_sync_result', $result);
            $this->logger->log('Member sync from iConnect completed with failed member writes', 'ERROR', $result);
            return $result;
        }

        // Mark the migration only after both feeds were read and every member's
        // country metadata was confirmed. Failed/busy/partial runs retry later.
        update_option(self::COUNTRY_DATA_VERSION_OPTION, self::COUNTRY_DATA_VERSION);
        $result = [
            'status' => 'completed',
            'reason' => null,
            'total_members_fetched' => $total_members,
            'pages_fetched' => $pages_fetched,
            'deleted_count' => $deleted_count,
            'duplicate_feed_ids' => $sync_stats['duplicate_feed_ids'] ?? [],
            'started_at' => $started_at,
            'completed_at' => time(),
        ];
        update_option('gsf_last_sync_result', $result);
        $this->logger->log('Member sync from iConnect completed', 'INFO', $result);
        return $result;
    }

    /**
     * Sync countries data from Zoho
     */
    // [ICONNECT 2026-07-09] Method name kept so no callers change. Countries now
    // come from iConnect instead of the Zoho Countries1 module.
    private function syncCountriesFromZoho()
    {
        // [ICONNECT 2026-07-09] GET {base}/api/public/gsf-map/countries with an
        // X-Api-Key header. The endpoint returns a bare JSON array in a single
        // response (no pagination), and each row has exactly the same shape as
        // a Zoho Countries1 record (Country.name, Country.id, Income_Group,
        // GSF_Region_Classification, Flag), so the per-row field mapping below
        // is preserved VERBATIM from the original code. The option keys
        // (gsf_zoho_countries, gsf_zoho_last_country_sync) are intentionally
        // unchanged so everything downstream keeps working.
        $this->logger->log('Fetching countries from iConnect', 'INFO');

        $rows = $this->fetchIconnectCollection('/api/public/gsf-map/countries', 'countries');
        if ($rows === null) {
            return false;
        }

        $countries = [];
        foreach ($rows as $country_data) {
            $country_name = is_array($country_data)
                ? trim((string) ($country_data['Country']['name'] ?? ''))
                : '';
            if (
                $country_name === ''
                || strcasecmp($country_name, 'Multiple locations') === 0
            ) {
                // Only a literal empty response represents an intentionally
                // empty LMIC list. A non-empty malformed response must retain
                // the previous option and retry rather than clearing the map.
                $this->logger->log('iConnect countries endpoint returned a malformed country row', 'ERROR');
                return false;
            }
            $countries[$country_name] = [
                'id' => $country_data['id'] ?? '',
                'zoho_country_id' => $country_data['Country']['id'] ?? '',
                'income_group' => $country_data['Income_Group'] ?? '',
                'region' => $country_data['GSF_Region_Classification'] ?? '',
                'flag' => $country_data['Flag'] ?? ''
            ];
        }

        // A successful empty array is authoritative: it represents an
        // intentionally empty tenant LMIC selection. Persist it so the member
        // pass can clear stale country metadata and complete this versioned
        // refresh. Transport/schema failures returned null above.
        update_option('gsf_zoho_countries', $countries);
        update_option('gsf_zoho_last_country_sync', time());
        $this->lastCountrySyncTime = time();

        $this->logger->log('Countries sync completed', 'INFO', [
            'count' => count($countries),
            'pages_fetched' => 1 // iConnect returns everything in one response
        ]);

        return true;

        // ==================== ORIGINAL ZOHO CODE (disabled 2026-07-09) ====================
        // Kept for review -- safe to delete once the iConnect switch-over is verified.
        // -------------------------------------------------------------------------------
        // $this->logger->log('Fetching countries from Zoho', 'INFO');
        // $this->maybeRefreshToken();
        //
        // $countries = [];
        // $page = 1;
        // $perPage = 200;
        // $hasMorePages = true;
        //
        // while ($hasMorePages) {
            // $url = 'https://www.zohoapis.eu/crm/v2/Countries1?per_page=' . $perPage . '&page=' . $page;
        //
            // $this->logger->log('Fetching countries page', 'DEBUG', [
                // 'page' => $page,
                // 'per_page' => $perPage
            // ]);
        //
            // $response = wp_remote_get($url, [
                // 'headers' => [
                    // 'Authorization' => 'Zoho-oauthtoken ' . $this->accessToken,
                    // 'Content-Type' => 'application/json'
                // ],
                // 'timeout' => 30
            // ]);
        //
            // if (is_wp_error($response)) {
                // $this->logger->log('Countries API request failed', 'ERROR', [
                    // 'error' => $response->get_error_message(),
                    // 'page' => $page
                // ]);
                // return false;
            // }
        //
            // $body = json_decode(wp_remote_retrieve_body($response), true);
        //
            // if (isset($body['data']) && is_array($body['data']) && count($body['data']) > 0) {
                // foreach ($body['data'] as $country_data) {
                    // if (isset($country_data['Country']['name'])) {
                        // $country_name = $country_data['Country']['name'];
                        // $countries[$country_name] = [
                            // 'id' => $country_data['id'],
                            // 'zoho_country_id' => $country_data['Country']['id'],
                            // 'income_group' => $country_data['Income_Group'] ?? '',
                            // 'region' => $country_data['GSF_Region_Classification'] ?? '',
                            // 'flag' => $country_data['Flag'] ?? ''
                        // ];
                    // }
                // }
        //
                // // Check if there are more pages
                // if (count($body['data']) < $perPage) {
                    // // This was the last page
                    // $hasMorePages = false;
                // } else {
                    // // Move to next page
                    // $page++;
                // }
            // } else {
                // // No more data
                // $hasMorePages = false;
        //
                // if ($page === 1) {
                    // // No data on first page - likely an error
                    // $this->logger->log('Invalid response from Zoho Countries API', 'ERROR', [
                        // 'response' => $body
                    // ]);
                    // return false;
                // }
            // }
        // }
        //
        // // Save countries to an option
        // update_option('gsf_zoho_countries', $countries);
        // update_option('gsf_zoho_last_country_sync', time());
        // $this->lastCountrySyncTime = time();
        //
        // $this->logger->log('Countries sync completed', 'INFO', [
            // 'count' => count($countries),
            // 'pages_fetched' => $page
        // ]);
        //
        // return true;
        // ==================== END ORIGINAL ZOHO CODE ===================================
    }

    /**
     * Return total member accounts matching sync criteria (all pages).
     *
     * @return int|null Member count, or null if the Zoho API request failed.
     */
    public function countZohoMembers()
    {
        // [ICONNECT 2026-07-09] No token refresh needed for iConnect (no-op anyway).
        // ==================== ORIGINAL ZOHO CODE (disabled 2026-07-09) ====================
        // Kept for review -- safe to delete once the iConnect switch-over is verified.
        // -------------------------------------------------------------------------------
        // $this->maybeRefreshToken();
        // ==================== END ORIGINAL ZOHO CODE ===================================
        $fetchResult = $this->fetchAllMembersFromZoho();

        return $fetchResult === null ? null : count($fetchResult['members']);
    }

    // [ICONNECT 2026-07-09] Debug fetch repointed at the two iConnect endpoints so
    // the plugin's debug path no longer hits Zoho. The return shape is kept
    // compatible with the original (success / raw_data / member_count /
    // country_data / all_countries / country_count / country_pages_fetched);
    // raw_data emulates the old Zoho envelope by slicing the requested page out
    // of the full member list.
    public function testGetZohoData($page = 1, $perPage = 10)
    {
        $this->logger->log('TESTING: Fetching raw iConnect data for debugging', 'INFO');

        $members = $this->fetchIconnectCollection('/api/public/gsf-map/members', 'members (debug)');
        if ($members === null) {
            return [
                'success' => false,
                'error' => 'iConnect members request failed - see the GSF log for details'
            ];
        }

        // Emulate the old paged Zoho debug view for backward compatibility.
        $offset = max(0, ($page - 1) * $perPage);
        $pageSlice = array_slice($members, $offset, $perPage);
        $rawData = [
            'data' => $pageSlice,
            'info' => [
                'more_records' => ($offset + $perPage) < count($members)
            ]
        ];

        $allCountries = $this->fetchIconnectCollection('/api/public/gsf-map/countries', 'countries (debug)');
        if ($allCountries === null) {
            $allCountries = [];
        }

        $this->logger->log('Raw iConnect debug data received', 'DEBUG', [
            'member_count_total' => count($members),
            'country_count' => count($allCountries)
        ]);

        return [
            'success' => true,
            'raw_data' => $rawData,
            'member_count' => count($pageSlice),
            'country_data' => ['data' => $allCountries], // first-page equivalent
            'all_countries' => $allCountries,
            'country_count' => count($allCountries),
            'country_pages_fetched' => 1
        ];

        // ==================== ORIGINAL ZOHO CODE (disabled 2026-07-09) ====================
        // Kept for review -- safe to delete once the iConnect switch-over is verified.
        // -------------------------------------------------------------------------------
        // $this->logger->log('TESTING: Fetching raw Zoho data for debugging', 'INFO');
        // $this->maybeRefreshToken();
        //
        // $criteria = $this->getMemberSearchCriteria();
        // $baseUrl = 'https://www.zohoapis.eu/crm/v2/Accounts/search';
        // $queryArgs = http_build_query([
            // 'criteria' => $criteria,
            // 'page' => $page,
            // 'per_page' => $perPage
        // ]);
        // $url = $baseUrl . '?' . $queryArgs;
        //
        // $this->logger->log('Making Zoho API debug request for members', 'DEBUG', [
            // 'url' => $url
        // ]);
        //
        // $response = wp_remote_get($url, [
            // 'headers' => [
                // 'Authorization' => 'Zoho-oauthtoken ' . $this->accessToken,
                // 'Content-Type' => 'application/json'
            // ]
        // ]);
        //
        // if (is_wp_error($response)) {
            // $this->logger->log('Zoho API debug request failed', 'ERROR', [
                // 'error' => $response->get_error_message()
            // ]);
            // return [
                // 'success' => false,
                // 'error' => $response->get_error_message()
            // ];
        // }
        //
        // $body = json_decode(wp_remote_retrieve_body($response), true);
        // $this->logger->log('Raw Zoho API response received', 'DEBUG');
        // $this->logger->log('Raw response data', 'DEBUG', [
            // 'response' => $body
        // ]);
        //
        // // Also fetch countries data for debugging - paginate through all pages
        // $countryData = [];
        // $allCountries = [];
        // $countryPage = 1;
        // $countryPerPage = 200;
        // $hasMoreCountryPages = true;
        //
        // while ($hasMoreCountryPages) {
            // $countryUrl = 'https://www.zohoapis.eu/crm/v2/Countries1?per_page=' . $countryPerPage . '&page=' . $countryPage;
            // $countryResponse = wp_remote_get($countryUrl, [
                // 'headers' => [
                    // 'Authorization' => 'Zoho-oauthtoken ' . $this->accessToken,
                    // 'Content-Type' => 'application/json'
                // ],
                // 'timeout' => 30
            // ]);
        //
            // if (!is_wp_error($countryResponse)) {
                // $countryBody = json_decode(wp_remote_retrieve_body($countryResponse), true);
        //
                // if ($countryPage === 1) {
                    // $countryData = $countryBody; // Store first page for backward compatibility
                // }
        //
                // if (isset($countryBody['data']) && is_array($countryBody['data']) && count($countryBody['data']) > 0) {
                    // $allCountries = array_merge($allCountries, $countryBody['data']);
        //
                    // if (count($countryBody['data']) < $countryPerPage) {
                        // $hasMoreCountryPages = false;
                    // } else {
                        // $countryPage++;
                    // }
                // } else {
                    // $hasMoreCountryPages = false;
                // }
        //
                // $this->logger->log('Countries API data received', 'DEBUG', [
                    // 'page' => $countryPage,
                    // 'count_this_page' => isset($countryBody['data']) ? count($countryBody['data']) : 0
                // ]);
            // } else {
                // $this->logger->log('Countries API request failed', 'ERROR', [
                    // 'error' => $countryResponse->get_error_message(),
                    // 'page' => $countryPage
                // ]);
                // $hasMoreCountryPages = false;
            // }
        // }
        //
        // // Return the raw response data
        // return [
            // 'success' => true,
            // 'raw_data' => $body,
            // 'member_count' => isset($body['data']) ? count($body['data']) : 0,
            // 'country_data' => $countryData,
            // 'all_countries' => $allCountries,
            // 'country_count' => count($allCountries),
            // 'country_pages_fetched' => $countryPage
        // ];
        // ==================== END ORIGINAL ZOHO CODE ===================================
    }

    // [ICONNECT 2026-07-09] getCountries() below is untouched: it still reads the
    // gsf_zoho_countries option (name kept for compatibility), which is now
    // populated from iConnect by syncCountriesFromZoho() above.
    /**
     * Get all countries from Zoho data that has been synced
     * 
     * @return array Array of country information
     */
    public function getCountries()
    {
        // If test data is enabled, return test country data
        if (get_option('gsf_use_test_data', false)) {
            return $this->getTestCountryData();
        }

        $countries = get_option('gsf_zoho_countries', []);

        // Force sync if we don't have countries or it's time for a sync
        if (empty($countries) || !$this->lastCountrySyncTime || (time() - $this->lastCountrySyncTime) > $this->countrySyncInterval) {
            $this->syncCountriesFromZoho();
            $countries = get_option('gsf_zoho_countries', []);
        }

        return $countries;
    }

    /**
     * Generate test country data for use in test mode
     * 
     * @return array Test country data
     */
    private function getTestCountryData()
    {
        $test_countries = [
            'Afghanistan' => [
                'id' => '1001',
                'zoho_country_id' => '2001',
                'income_group' => 'Low Income',
                'region' => 'Asia',
                'flag' => 'Show'
            ],
            'Albania' => [
                'id' => '1002',
                'zoho_country_id' => '2002',
                'income_group' => 'Upper Middle Income',
                'region' => 'Europe',
                'flag' => 'Show'
            ],
            'Algeria' => [
                'id' => '1003',
                'zoho_country_id' => '2003',
                'income_group' => 'Lower Middle Income',
                'region' => 'Africa',
                'flag' => 'Show'
            ],
            'India' => [
                'id' => '1004',
                'zoho_country_id' => '2004',
                'income_group' => 'Lower Middle Income',
                'region' => 'Asia',
                'flag' => 'Show'
            ],
            'Kenya' => [
                'id' => '1005',
                'zoho_country_id' => '2005',
                'income_group' => 'Lower Middle Income',
                'region' => 'Africa',
                'flag' => 'Show'
            ],
            'Nigeria' => [
                'id' => '1006',
                'zoho_country_id' => '2006',
                'income_group' => 'Lower Middle Income',
                'region' => 'Africa',
                'flag' => 'Show'
            ],
            'Bangladesh' => [
                'id' => '1007',
                'zoho_country_id' => '2007',
                'income_group' => 'Lower Middle Income',
                'region' => 'Asia',
                'flag' => 'Show'
            ],
            'Nepal' => [
                'id' => '1008',
                'zoho_country_id' => '2008',
                'income_group' => 'Low Income',
                'region' => 'Asia',
                'flag' => 'Show'
            ],
            'Ethiopia' => [
                'id' => '1009',
                'zoho_country_id' => '2009',
                'income_group' => 'Low Income',
                'region' => 'Africa',
                'flag' => 'Show'
            ],
            'Brazil' => [
                'id' => '1010',
                'zoho_country_id' => '2010',
                'income_group' => 'Upper Middle Income',
                'region' => 'South America',
                'flag' => 'Show'
            ],
            'Mexico' => [
                'id' => '1011',
                'zoho_country_id' => '2011',
                'income_group' => 'Upper Middle Income',
                'region' => 'North America',
                'flag' => 'Show'
            ],
            'United States' => [
                'id' => '1012',
                'zoho_country_id' => '2012',
                'income_group' => 'High Income',
                'region' => 'North America',
                'flag' => 'Show'
            ],
            'United Kingdom' => [
                'id' => '1013',
                'zoho_country_id' => '2013',
                'income_group' => 'High Income',
                'region' => 'Europe',
                'flag' => 'Show'
            ],
            'Somalia' => [
                'id' => '1014',
                'zoho_country_id' => '2014',
                'income_group' => 'Low Income',
                'region' => 'Africa',
                'flag' => 'Show'
            ],
            'Sudan' => [
                'id' => '1015',
                'zoho_country_id' => '2015',
                'income_group' => 'Low Income',
                'region' => 'Africa',
                'flag' => 'Show'
            ],
            'Colombia' => [
                'id' => '1016',
                'zoho_country_id' => '2016',
                'income_group' => 'Upper Middle Income',
                'region' => 'South America',
                'flag' => 'Show'
            ],
            'Argentina' => [
                'id' => '1017',
                'zoho_country_id' => '2017',
                'income_group' => 'Upper Middle Income',
                'region' => 'South America',
                'flag' => 'Show'
            ],
            'Andorra' => [
                'id' => '1018',
                'zoho_country_id' => '2018',
                'income_group' => 'High Income',
                'region' => 'Europe',
                'flag' => 'Hide', // Added Hide flag to test filtering
                'flag' => 'Hide'
            ],
            'Tanzania' => [
                'id' => '1019',
                'zoho_country_id' => '2019',
                'income_group' => 'Lower Middle Income',
                'region' => 'Africa',
                'flag' => 'Show'
            ],
            'Uganda' => [
                'id' => '1019',
                'zoho_country_id' => '2019',
                'income_group' => 'Low Income',
                'region' => 'Africa',
                'flag' => 'Show'
            ],
            'Bhutan' => [
                'id' => '1020',
                'zoho_country_id' => '2020',
                'income_group' => 'Lower Middle Income',
                'region' => 'Asia',
                'flag' => 'Show'
            ],
            'Ghana' => [
                'id' => '1021',
                'zoho_country_id' => '2021',
                'income_group' => 'Lower Middle Income',
                'region' => 'Africa',
                'flag' => 'Show'
            ]
        ];

        return $test_countries;
    }

    // [ICONNECT 2026-07-09] The two debug helpers below (clearCachedTokens,
    // getTokenStatus) only touch the now-unused legacy Zoho token options.
    // They are harmless and kept as-is; clearCachedTokens() can be used once to
    // clean the stale Zoho tokens out of wp_options after the switch-over.
    /**
     * Clear cached Zoho tokens (useful for debugging)
     */
    public function clearCachedTokens()
    {
        delete_option('gsf_zoho_access_token');
        delete_option('gsf_zoho_token_expiry');
        delete_option('gsf_zoho_last_token_refresh');

        $this->accessToken = null;
        $this->tokenExpiry = 0;

        $this->logger->log('Cached Zoho tokens cleared', 'INFO');
    }

    /**
     * Get token status for debugging
     */
    public function getTokenStatus()
    {
        return [
            'access_token' => $this->accessToken ? substr($this->accessToken, 0, 20) . '...' : 'none',
            'token_expiry' => $this->tokenExpiry,
            'token_expiry_human' => $this->tokenExpiry ? wp_date('Y-m-d H:i:s', $this->tokenExpiry) : 'none',
            'expires_in_seconds' => $this->tokenExpiry ? max(0, $this->tokenExpiry - time()) : 0,
            'is_expired' => $this->tokenExpiry ? (time() > $this->tokenExpiry) : true,
            'last_sync' => $this->lastSyncTime ? wp_date('Y-m-d H:i:s', $this->lastSyncTime) : 'never',
            'last_token_refresh' => get_option('gsf_zoho_last_token_refresh', 0) ? wp_date('Y-m-d H:i:s', get_option('gsf_zoho_last_token_refresh', 0)) : 'never'
        ];
    }

    /**
     * Public method to trigger country synchronization from Zoho
     * 
     * @return boolean Success status
     */
    public function forceSyncCountries()
    {
        return $this->syncCountriesFromZoho();
    }
}

/**
 * [ICONNECT 2026-08-25] Permanent administrator settings for the GSF feed.
 * The API key is write-only: it is stored for server requests but never
 * rendered back into the WordPress admin page.
 */
if (!class_exists('GSF_Iconnect_Feed_Settings_Admin')) {
    class GSF_Iconnect_Feed_Settings_Admin
    {
        const PAGE_SLUG = 'gsf-iconnect-feed-settings';
        const POST_ACTION = 'gsf_iconnect_feed_settings_save';
        const NONCE_ACTION = 'gsf_iconnect_feed_settings_save';
        const NOTICE_PREFIX = 'gsf_iconnect_feed_settings_notice_';
        const DEFAULT_BASE_URL = 'https://iconn.app';

        public static function register()
        {
            add_action('admin_menu', [__CLASS__, 'registerMenu']);
            add_action('admin_post_' . self::POST_ACTION, [__CLASS__, 'handlePost']);
        }

        public static function registerMenu()
        {
            add_options_page(
                'GSF iConnect Feed',
                'GSF iConnect Feed',
                'manage_options',
                self::PAGE_SLUG,
                [__CLASS__, 'renderPage']
            );
        }

        public static function pageUrl()
        {
            return add_query_arg(['page' => self::PAGE_SLUG], admin_url('options-general.php'));
        }

        private static function normaliseBaseUrl($raw_url)
        {
            $base_url = rtrim(trim((string) $raw_url), '/');
            $base_url = esc_url_raw($base_url);
            $parts = $base_url === '' ? false : wp_parse_url($base_url);
            $path = is_array($parts) ? (string) ($parts['path'] ?? '') : '';
            $host = is_array($parts) ? strtolower(trim((string) ($parts['host'] ?? ''))) : '';
            $iconn_suffix = '.iconn.app';
            $trusted_host = $host === 'iconn.app'
                || (
                    strlen($host) > strlen($iconn_suffix)
                    && substr($host, -strlen($iconn_suffix)) === $iconn_suffix
                );
            if (
                !is_array($parts)
                || strtolower((string) ($parts['scheme'] ?? '')) !== 'https'
                || !$trusted_host
                || !empty($parts['port'])
                || !empty($parts['user'])
                || !empty($parts['pass'])
                || !empty($parts['query'])
                || !empty($parts['fragment'])
                || ($path !== '' && $path !== '/')
            ) {
                throw new RuntimeException(
                    'Enter an HTTPS iconn.app origin only, for example https://iconn.app, with no port, path, query, or credentials.'
                );
            }
            return rtrim($base_url, '/');
        }

        public static function processSettingsPost($source, $request_method)
        {
            if (!current_user_can('manage_options')) {
                throw new RuntimeException('Administrator permission is required.');
            }
            if (strtoupper((string) $request_method) !== 'POST') {
                throw new RuntimeException('Settings changes require a POST request.');
            }
            if (!wp_verify_nonce(
                (string) ($source['_gsf_iconnect_settings_nonce'] ?? ''),
                self::NONCE_ACTION
            )) {
                throw new RuntimeException('The settings security token is invalid or expired.');
            }

            $base_url = self::normaliseBaseUrl(
                wp_unslash($source['gsf_iconnect_base_url'] ?? '')
            );
            $submitted_key = trim((string) wp_unslash($source['gsf_iconnect_api_key'] ?? ''));
            if ($submitted_key !== '' && preg_match('/[\x00-\x1F\x7F]/', $submitted_key)) {
                throw new RuntimeException('The API key contains unsupported control characters.');
            }
            $saved_key = trim((string) get_option('gsf_iconnect_api_key', ''));
            $api_key = $submitted_key === '' ? $saved_key : $submitted_key;
            if ($api_key === '') {
                throw new RuntimeException('Enter the API key before saving these settings.');
            }

            update_option('gsf_iconnect_base_url', $base_url, false);
            if ($submitted_key !== '') {
                update_option('gsf_iconnect_api_key', $submitted_key, false);
            }

            if (sanitize_key((string) ($source['operation'] ?? 'save')) !== 'save-and-test') {
                return [
                    'type' => 'success',
                    'message' => 'GSF iConnect feed settings saved.',
                    'connection' => null,
                ];
            }

            $connection = GSF_Reviewed_Duplicate_Cleanup_Admin::fetchFeed($base_url, $api_key);
            if (empty($connection['available'])) {
                return [
                    'type' => 'error',
                    'message' => 'Settings saved, but the connection test failed: '
                        . ($connection['error'] ?? 'Unknown feed error'),
                    'connection' => $connection,
                ];
            }
            return [
                'type' => 'success',
                'message' => 'Connection successful. The members endpoint returned '
                    . count($connection['rows']) . ' records.',
                'connection' => $connection,
            ];
        }

        public static function handlePost()
        {
            try {
                $notice = self::processSettingsPost(
                    $_POST,
                    $_SERVER['REQUEST_METHOD'] ?? 'GET'
                );
            } catch (Throwable $error) {
                $notice = [
                    'type' => 'error',
                    'message' => $error->getMessage(),
                    'connection' => null,
                ];
            }
            set_transient(
                self::NOTICE_PREFIX . (int) get_current_user_id(),
                [
                    'type' => $notice['type'] ?? 'error',
                    'message' => $notice['message'] ?? 'Settings could not be saved.',
                ],
                120
            );
            wp_safe_redirect(self::pageUrl());
            exit;
        }

        public static function renderPage()
        {
            if (!current_user_can('manage_options')) {
                wp_die('Administrator permission is required.', '', ['response' => 403]);
            }
            $notice_key = self::NOTICE_PREFIX . (int) get_current_user_id();
            $notice = get_transient($notice_key);
            if ($notice !== false) {
                delete_transient($notice_key);
            }
            $base_url = rtrim(trim((string) get_option('gsf_iconnect_base_url', '')), '/');
            $shown_base_url = $base_url === '' ? self::DEFAULT_BASE_URL : $base_url;
            $api_key_is_set = trim((string) get_option('gsf_iconnect_api_key', '')) !== '';
            ?>
            <div class="wrap">
                <h1>GSF iConnect Feed</h1>
                <p>Configure the live iConnect origin and shared API key used by the GSF member and country syncs.
                    The saved key is never displayed on this page.</p>
                <?php if (is_array($notice)): ?>
                    <div class="notice notice-<?php echo ($notice['type'] ?? '') === 'success' ? 'success' : 'error'; ?> inline">
                        <p><?php echo esc_html($notice['message'] ?? 'Settings could not be saved.'); ?></p>
                    </div>
                <?php endif; ?>
                <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>">
                    <input type="hidden" name="action" value="<?php echo esc_attr(self::POST_ACTION); ?>">
                    <?php wp_nonce_field(self::NONCE_ACTION, '_gsf_iconnect_settings_nonce'); ?>
                    <table class="form-table" role="presentation">
                        <tr>
                            <th scope="row"><label for="gsf_iconnect_base_url">iConnect base URL</label></th>
                            <td>
                                <input type="url" class="regular-text code" id="gsf_iconnect_base_url"
                                    name="gsf_iconnect_base_url" value="<?php echo esc_attr($shown_base_url); ?>"
                                    placeholder="<?php echo esc_attr(self::DEFAULT_BASE_URL); ?>" required>
                                <p class="description">HTTPS origin only, with no trailing slash or endpoint path.</p>
                            </td>
                        </tr>
                        <tr>
                            <th scope="row"><label for="gsf_iconnect_api_key">Shared API key</label></th>
                            <td>
                                <input type="password" class="regular-text" id="gsf_iconnect_api_key"
                                    name="gsf_iconnect_api_key" value="" autocomplete="new-password"
                                    <?php echo $api_key_is_set ? '' : 'required'; ?>>
                                <p class="description">
                                    <?php if ($api_key_is_set): ?>
                                        An API key is configured. Leave blank to keep it, or enter a new value to replace it.
                                    <?php else: ?>
                                        Enter the value configured as <code>GSF_MAP_API_SECRET</code> on live iConnect.
                                    <?php endif; ?>
                                </p>
                            </td>
                        </tr>
                    </table>
                    <p class="submit">
                        <button type="submit" class="button button-secondary" name="operation" value="save">Save settings</button>
                        <button type="submit" class="button button-primary" name="operation" value="save-and-test">Save and test connection</button>
                    </p>
                </form>
                <h2>Endpoints</h2>
                <p><code><?php echo esc_html($shown_base_url . '/api/public/gsf-map/members'); ?></code><br>
                    <code><?php echo esc_html($shown_base_url . '/api/public/gsf-map/countries'); ?></code></p>
            </div>
            <?php
        }
    }
}

/**
 * [ICONNECT 2026-08-25] Temporary browser-only cleanup for the five reviewed
 * duplicate member identities. This deliberately lives in the replaceable
 * ZohoAPI distribution so an operator without WP-CLI can install it by replacing
 * the same PHP file. Remove this cleanup class and its two cleanup action
 * registrations after the evidence has been downloaded; keep the settings class.
 */
if (!class_exists('GSF_Reviewed_Duplicate_Cleanup_Admin')) {
    class GSF_Reviewed_Duplicate_Cleanup_Admin
    {
        const PAGE_SLUG = 'gsf-reviewed-duplicate-cleanup';
        const POST_ACTION = 'gsf_reviewed_duplicate_cleanup';
        const DOWNLOAD_ACTION = 'gsf_reviewed_duplicate_cleanup_download';
        const LOCK_OPTION = 'gsf_iconnect_member_sync_lock';
        const DB_LOCK_NAME = 'gsf_iconnect_member_sync';
        const LOCK_TTL = 900;
        const EVIDENCE_TTL = 86400;
        const EXPECTED_FEED_COUNT = 232;
        const EXPECTED_PRE_CLEANUP_POST_COUNT = 237;
        const CONFIRMATION_PHRASE = 'DELETE REVIEWED DUPLICATES';
        const DRY_RUN_NONCE_ACTION = 'gsf_reviewed_duplicate_cleanup_dry_run';
        const APPLY_NONCE_PREFIX = 'gsf_reviewed_duplicate_cleanup_apply_';
        const DOWNLOAD_NONCE_PREFIX = 'gsf_reviewed_duplicate_cleanup_download_';

        const REVIEWED_IDENTITIES = [
            '815132000006866401' => 'Abaarso Network',
            '815132000006866292' => 'Rangeet',
            '815132000006866295' => 'Sabre Education',
            '815132000006929885' => 'Learning Equality',
            '815132000012585001' => 'Plato Cultural',
        ];

        public static function register()
        {
            add_action('admin_menu', [__CLASS__, 'registerMenu']);
            add_action('admin_post_' . self::POST_ACTION, [__CLASS__, 'handlePost']);
            add_action('admin_post_' . self::DOWNLOAD_ACTION, [__CLASS__, 'handleDownload']);
        }

        public static function registerMenu()
        {
            add_submenu_page(
                'edit.php?post_type=gsf_member',
                'Reviewed Member Duplicate Cleanup',
                'Duplicate Cleanup',
                'manage_options',
                self::PAGE_SLUG,
                [__CLASS__, 'renderPage']
            );
        }

        private static function allStatuses()
        {
            $statuses = array_values(get_post_stati([], 'names'));
            return empty($statuses)
                ? ['publish', 'draft', 'pending', 'private', 'future', 'trash']
                : $statuses;
        }

        private static function findMatches($feed_id)
        {
            return get_posts([
                'post_type' => 'gsf_member',
                'post_status' => self::allStatuses(),
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

        private static function selectCanonical($posts)
        {
            if (empty($posts)) {
                return null;
            }
            usort($posts, function ($left, $right) {
                $left_published = $left->post_status === 'publish' ? 0 : 1;
                $right_published = $right->post_status === 'publish' ? 0 : 1;
                if ($left_published !== $right_published) {
                    return $left_published <=> $right_published;
                }
                return ((int) $left->ID) <=> ((int) $right->ID);
            });
            return $posts[0];
        }

        private static function describePost($post)
        {
            return [
                'wp_post_id' => (int) $post->ID,
                'status' => (string) $post->post_status,
                'name' => html_entity_decode((string) $post->post_title, ENT_QUOTES, 'UTF-8'),
                'feed_id' => trim((string) get_post_meta($post->ID, 'zoho_id', true)),
                'created_at' => (string) $post->post_date,
                'created_at_gmt' => (string) ($post->post_date_gmt ?? ''),
                'modified_at' => (string) $post->post_modified,
                'modified_at_gmt' => (string) ($post->post_modified_gmt ?? ''),
                'last_sync' => (string) get_post_meta($post->ID, 'last_sync', true),
            ];
        }

        public static function fetchFeed($base_url = null, $api_key = null)
        {
            $base_url = $base_url === null
                ? rtrim(trim((string) get_option('gsf_iconnect_base_url', '')), '/')
                : rtrim(trim((string) $base_url), '/');
            $api_key = $api_key === null
                ? trim((string) get_option('gsf_iconnect_api_key', ''))
                : trim((string) $api_key);
            $source = $base_url === ''
                ? 'WordPress option gsf_iconnect_base_url (no endpoint configured)'
                : $base_url . '/api/public/gsf-map/members';
            if ($base_url === '' || $api_key === '') {
                $missing = [];
                if ($base_url === '') {
                    $missing[] = 'gsf_iconnect_base_url';
                }
                if ($api_key === '') {
                    $missing[] = 'gsf_iconnect_api_key';
                }
                return [
                    'available' => false,
                    'source' => $source,
                    'rows' => null,
                    'failure_kind' => 'missing_configuration',
                    'http_status' => null,
                    'error' => 'Missing WordPress option: ' . implode(', ', $missing),
                ];
            }

            $response = wp_remote_get($source, [
                'headers' => [
                    'X-Api-Key' => $api_key,
                    'Accept' => 'application/json',
                ],
                'timeout' => 60,
            ]);
            if (is_wp_error($response)) {
                return [
                    'available' => false,
                    'source' => $source,
                    'rows' => null,
                    'failure_kind' => 'network_error',
                    'http_status' => null,
                    'error' => 'WordPress HTTP request failed: ' . $response->get_error_message(),
                ];
            }

            $status = (int) wp_remote_retrieve_response_code($response);
            $body = (string) wp_remote_retrieve_body($response);
            if ($status !== 200) {
                $body_excerpt = trim((string) preg_replace('/\s+/', ' ', $body));
                if (strlen($body_excerpt) > 500) {
                    $body_excerpt = substr($body_excerpt, 0, 500) . '...';
                }
                return [
                    'available' => false,
                    'source' => $source,
                    'rows' => null,
                    'failure_kind' => 'http_error',
                    'http_status' => $status,
                    'error' => 'iConnect member feed returned HTTP ' . $status
                        . ($body_excerpt === '' ? '' : ': ' . $body_excerpt),
                ];
            }

            $decoded = json_decode($body, true);
            if (json_last_error() !== JSON_ERROR_NONE) {
                return [
                    'available' => false,
                    'source' => $source,
                    'rows' => null,
                    'failure_kind' => 'malformed_json',
                    'http_status' => $status,
                    'error' => 'iConnect member feed returned malformed JSON: ' . json_last_error_msg(),
                ];
            }
            if (!is_array($decoded) || !self::isListArray($decoded)) {
                return [
                    'available' => false,
                    'source' => $source,
                    'rows' => null,
                    'failure_kind' => 'invalid_payload',
                    'http_status' => $status,
                    'error' => 'iConnect member feed returned valid JSON, but the top-level value was not a row array',
                ];
            }

            return [
                'available' => true,
                'source' => $source,
                'rows' => $decoded,
                'failure_kind' => null,
                'http_status' => $status,
                'error' => null,
            ];
        }

        private static function isListArray($value)
        {
            if (!is_array($value)) {
                return false;
            }
            return array_keys($value) === range(0, count($value) - 1) || $value === [];
        }

        private static function gate($passed, $detail, $available = true)
        {
            return [
                'passed' => $available && (bool) $passed,
                'available' => (bool) $available,
                'detail' => (string) $detail,
            ];
        }

        private static function feedUnavailableMessage($report)
        {
            $source = (string) ($report['feed']['source'] ?? 'unknown source');
            $error = (string) ($report['feed']['error'] ?? 'no trustworthy feed was obtained');
            return 'Feed reconciliation unavailable from ' . $source . ': ' . $error;
        }

        private static function buildIdentitySnapshot($feed_by_id, $records)
        {
            $feed_ids = array_values(array_map('strval', array_keys($feed_by_id)));
            sort($feed_ids, SORT_STRING);
            $wordpress = array_map(function ($record) {
                return [
                    'wp_post_id' => (int) $record['wp_post_id'],
                    'status' => (string) $record['status'],
                    'feed_id' => (string) $record['feed_id'],
                ];
            }, $records);
            usort($wordpress, function ($left, $right) {
                return $left['wp_post_id'] <=> $right['wp_post_id'];
            });
            return [
                'feed_ids' => $feed_ids,
                'wordpress' => $wordpress,
            ];
        }

        private static function identitySignature($snapshot)
        {
            return hash('sha256', wp_json_encode([
                'feed_ids' => array_values($snapshot['feed_ids'] ?? []),
                'wordpress' => array_values($snapshot['wordpress'] ?? []),
            ]));
        }

        private static function identitySnapshotAfterDeletions($snapshot, $deleted_post_ids)
        {
            $deleted = array_fill_keys(array_map('intval', $deleted_post_ids), true);
            $next = $snapshot;
            $next['wordpress'] = array_values(array_filter(
                $snapshot['wordpress'] ?? [],
                function ($record) use ($deleted) {
                    return !isset($deleted[(int) ($record['wp_post_id'] ?? 0)]);
                }
            ));
            return $next;
        }

        /**
         * Build one all-status WordPress/configured-feed snapshot. This method is
         * public only so the distributable's regression harness can exercise the
         * exact browser report path without needing a WordPress HTTP server.
         */
        public static function buildInventoryReport()
        {
            $feed_result = self::fetchFeed();
            $feed_available = !empty($feed_result['available']);
            $feed_rows = $feed_available && is_array($feed_result['rows'])
                ? $feed_result['rows']
                : [];
            $feed_by_id = [];
            $feed_blank = [];
            foreach ($feed_rows as $row) {
                $feed_id = trim((string) ($row['id'] ?? ''));
                if ($feed_id === '') {
                    $feed_blank[] = [
                        'name' => (string) ($row['Account_Name'] ?? ''),
                    ];
                    continue;
                }
                if (!isset($feed_by_id[$feed_id])) {
                    $feed_by_id[$feed_id] = [];
                }
                $feed_by_id[$feed_id][] = [
                    'id' => $feed_id,
                    'name' => (string) ($row['Account_Name'] ?? ''),
                ];
            }

            $feed_duplicates = [];
            foreach ($feed_by_id as $feed_id => $rows) {
                if (count($rows) > 1) {
                    $feed_duplicates[$feed_id] = $rows;
                }
            }

            $posts = get_posts([
                'post_type' => 'gsf_member',
                'post_status' => self::allStatuses(),
                'posts_per_page' => -1,
                'orderby' => 'ID',
                'order' => 'ASC',
                'suppress_filters' => false,
            ]);
            $records = [];
            $posts_by_id = [];
            $published_by_id = [];
            $counts_by_status = [];
            foreach ($posts as $post) {
                $record = self::describePost($post);
                $records[] = $record;
                $counts_by_status[$record['status']] = ($counts_by_status[$record['status']] ?? 0) + 1;
                if ($record['feed_id'] !== '') {
                    if (!isset($posts_by_id[$record['feed_id']])) {
                        $posts_by_id[$record['feed_id']] = [];
                    }
                    $posts_by_id[$record['feed_id']][] = $record;
                    if ($record['status'] === 'publish') {
                        if (!isset($published_by_id[$record['feed_id']])) {
                            $published_by_id[$record['feed_id']] = [];
                        }
                        $published_by_id[$record['feed_id']][] = $record;
                    }
                }
            }

            $duplicates = [];
            foreach ($posts_by_id as $feed_id => $matches) {
                if (count($matches) > 1) {
                    $duplicates[$feed_id] = $matches;
                }
            }

            $blank_wordpress_ids = array_values(array_filter($records, function ($record) {
                return $record['feed_id'] === '';
            }));
            $stale_wordpress_ids = null;
            $missing_from_any_status = null;
            $missing_from_published = null;
            if ($feed_available) {
                $stale_wordpress_ids = array_values(array_filter($records, function ($record) use ($feed_by_id) {
                    return $record['feed_id'] !== '' && !isset($feed_by_id[$record['feed_id']]);
                }));
                $missing_from_any_status = [];
                $missing_from_published = [];
                foreach ($feed_by_id as $feed_id => $rows) {
                    if (!isset($posts_by_id[$feed_id])) {
                        $missing_from_any_status[] = $feed_id;
                    }
                    if (!isset($published_by_id[$feed_id])) {
                        $missing_from_published[] = $feed_id;
                    }
                }
            }

            $published_duplicates = [];
            foreach ($published_by_id as $feed_id => $matches) {
                if (count($matches) > 1) {
                    $published_duplicates[$feed_id] = $matches;
                }
            }

            $reviewed = [];
            foreach (self::REVIEWED_IDENTITIES as $feed_id_key => $expected_name) {
                // PHP coerces digit-only array keys to integers. Stable feed IDs
                // are identifiers, so normalize them back to strings at the
                // boundary before they enter reports, plans, or strict fences.
                $feed_id = (string) $feed_id_key;
                $matches = self::findMatches($feed_id);
                $canonical = self::selectCanonical($matches);
                $records_for_id = array_values(array_map([__CLASS__, 'describePost'], $matches));
                $noncanonical = [];
                foreach ($records_for_id as $record) {
                    if ($canonical === null || $record['wp_post_id'] !== (int) $canonical->ID) {
                        $noncanonical[] = $record;
                    }
                }
                $reviewed[] = [
                    'expected_name' => $expected_name,
                    'feed_id' => $feed_id,
                    'feed_rows' => $feed_available ? ($feed_by_id[$feed_id] ?? []) : null,
                    'records' => $records_for_id,
                    'canonical_record' => $canonical === null ? null : self::describePost($canonical),
                    'noncanonical_records' => $noncanonical,
                ];
            }

            $reviewed_ids = array_values(array_map('strval', array_keys(self::REVIEWED_IDENTITIES)));
            sort($reviewed_ids, SORT_STRING);
            $duplicate_ids = array_values(array_map('strval', array_keys($duplicates)));
            sort($duplicate_ids, SORT_STRING);
            $all_reviewed_are_pairs = true;
            foreach ($reviewed as $finding) {
                if (
                    count($finding['records']) !== 2
                    || count($finding['noncanonical_records']) !== 1
                    || $finding['canonical_record'] === null
                    || $finding['canonical_record']['status'] !== 'publish'
                    || !$feed_available
                    || count($finding['feed_rows'] ?? []) !== 1
                ) {
                    $all_reviewed_are_pairs = false;
                    break;
                }
            }

            $published_count = (int) ($counts_by_status['publish'] ?? 0);
            $feed_clean = $feed_available
                && count($feed_rows) === self::EXPECTED_FEED_COUNT
                && count($feed_by_id) === self::EXPECTED_FEED_COUNT
                && empty($feed_blank)
                && empty($feed_duplicates);
            $wordpress_identity_clean = empty($blank_wordpress_ids)
                && $feed_available
                && empty($stale_wordpress_ids)
                && empty($missing_from_any_status)
                && empty($missing_from_published);
            $pre_cleanup_safe = $feed_clean
                && count($records) === self::EXPECTED_PRE_CLEANUP_POST_COUNT
                && count($posts_by_id) === self::EXPECTED_FEED_COUNT
                && count($published_by_id) === self::EXPECTED_FEED_COUNT
                && $duplicate_ids === $reviewed_ids
                && $all_reviewed_are_pairs
                && $wordpress_identity_clean;
            $strict_clean = $feed_clean
                && count($records) === self::EXPECTED_FEED_COUNT
                && $published_count === self::EXPECTED_FEED_COUNT
                && count($posts_by_id) === self::EXPECTED_FEED_COUNT
                && count($published_by_id) === self::EXPECTED_FEED_COUNT
                && empty($duplicates)
                && $wordpress_identity_clean;

            $identity_snapshot = self::buildIdentitySnapshot($feed_by_id, $records);

            return [
                'generated_at' => gmdate('c'),
                'read_only' => true,
                'feed' => [
                    'available' => $feed_available,
                    'source' => $feed_result['source'],
                    'error' => $feed_result['error'],
                    'failure_kind' => $feed_result['failure_kind'],
                    'http_status' => $feed_result['http_status'],
                    'raw_records' => $feed_available ? count($feed_rows) : null,
                    'unique_nonblank_ids' => $feed_available ? count($feed_by_id) : null,
                    'blank_ids' => $feed_available ? $feed_blank : null,
                    'duplicate_ids' => $feed_available ? $feed_duplicates : null,
                ],
                'wordpress' => [
                    'registered_post_statuses' => self::allStatuses(),
                    'raw_posts' => count($records),
                    'published_posts' => $published_count,
                    'unique_nonblank_ids' => count($posts_by_id),
                    'published_unique_nonblank_ids' => count($published_by_id),
                    'counts_by_status' => $counts_by_status,
                    'duplicate_ids' => $duplicates,
                    'published_duplicate_ids' => $published_duplicates,
                    'blank_ids' => $blank_wordpress_ids,
                    'stale_ids' => $stale_wordpress_ids,
                    'missing_from_any_status' => $missing_from_any_status,
                    'missing_from_published' => $missing_from_published,
                    'records' => $records,
                ],
                'reviewed_identities' => $reviewed,
                'acceptance' => [
                    'configured_feed_has_232_unique_nonblank_ids' => self::gate(
                        $feed_clean,
                        $feed_available
                            ? count($feed_rows) . ' feed rows; ' . count($feed_by_id) . ' unique nonblank IDs'
                            : self::feedUnavailableMessage(['feed' => $feed_result]),
                        $feed_available
                    ),
                    'wordpress_has_232_published_members' => self::gate(
                        $published_count === self::EXPECTED_FEED_COUNT
                            && count($published_by_id) === self::EXPECTED_FEED_COUNT
                            && $feed_available
                            && empty($missing_from_published)
                            && empty($published_duplicates),
                        $feed_available
                            ? $published_count . ' raw published posts; ' . count($published_by_id)
                                . ' unique published stable identities'
                            : 'WordPress has ' . $published_count . ' raw published posts and '
                                . count($published_by_id) . ' unique published stable identities, but feed coverage is unavailable',
                        $feed_available
                    ),
                    'no_duplicate_wordpress_stable_ids' => self::gate(
                        empty($duplicates),
                        count($duplicates) . ' duplicate stable IDs'
                    ),
                    'no_blank_wordpress_stable_ids' => self::gate(
                        empty($blank_wordpress_ids),
                        count($blank_wordpress_ids) . ' blank stable IDs'
                    ),
                    'no_stale_wordpress_stable_ids' => self::gate(
                        $feed_available && empty($stale_wordpress_ids),
                        $feed_available
                            ? count($stale_wordpress_ids) . ' stale WordPress records'
                            : 'Unavailable because no trustworthy configured feed was obtained',
                        $feed_available
                    ),
                    'no_orphan_or_missing_stable_ids' => self::gate(
                        $feed_available && empty($missing_from_any_status) && empty($missing_from_published),
                        $feed_available
                            ? count($missing_from_any_status) . ' missing from all statuses; '
                                . count($missing_from_published) . ' missing from published'
                            : 'Unavailable because no trustworthy configured feed was obtained',
                        $feed_available
                    ),
                    'strict_post_cleanup_reconciliation_passed' => self::gate(
                        $strict_clean,
                        $feed_available
                            ? count($records) . ' all-status posts; ' . $published_count . ' raw published posts'
                            : 'Unavailable because strict reconciliation requires a trustworthy configured feed',
                        $feed_available
                    ),
                ],
                'pre_cleanup_checks' => [
                    'configured_feed_is_available_and_trustworthy' => self::gate(
                        $feed_available,
                        $feed_available
                            ? 'Feed obtained from ' . $feed_result['source']
                            : self::feedUnavailableMessage(['feed' => $feed_result]),
                        $feed_available
                    ),
                    'wordpress_has_237_all_status_posts_and_232_unique_ids' => self::gate(
                        count($records) === self::EXPECTED_PRE_CLEANUP_POST_COUNT
                            && count($posts_by_id) === self::EXPECTED_FEED_COUNT,
                        count($records) . ' all-status posts; ' . count($posts_by_id) . ' unique stable identities'
                    ),
                    'wordpress_has_232_unique_published_survivors' => self::gate(
                        count($published_by_id) === self::EXPECTED_FEED_COUNT,
                        $published_count . ' raw published posts; ' . count($published_by_id)
                            . ' unique published stable identities'
                    ),
                    'all_five_reviewed_identities_are_exact_pairs' => self::gate(
                        $all_reviewed_are_pairs && $duplicate_ids === $reviewed_ids,
                        count($duplicate_ids) . ' duplicate identities found; expected exactly the five reviewed IDs',
                        $feed_available
                    ),
                    'feed_reconciliation_has_no_blank_stale_or_missing_ids' => self::gate(
                        $feed_available
                            && empty($blank_wordpress_ids)
                            && empty($stale_wordpress_ids)
                            && empty($missing_from_any_status)
                            && empty($missing_from_published),
                        $feed_available
                            ? count($blank_wordpress_ids) . ' blank; '
                                . count($stale_wordpress_ids) . ' stale; '
                                . count($missing_from_any_status) . ' missing all-status; '
                                . count($missing_from_published) . ' missing published'
                            : 'Unavailable because no trustworthy configured feed was obtained',
                        $feed_available
                    ),
                    'safe_pre_cleanup_state' => self::gate(
                        $pre_cleanup_safe,
                        'Requires 232 clean feed IDs, 237 all-status posts, 232 unique published survivors, and only the five reviewed pairs; deletion candidates may also be published'
                    ),
                ],
                'pre_cleanup_safe' => $pre_cleanup_safe,
                'strict_clean' => $strict_clean,
                'identity_signature' => self::identitySignature($identity_snapshot),
                'identity_snapshot' => $identity_snapshot,
            ];
        }

        public static function buildDeletionPlan($report)
        {
            if (empty($report['feed']['available'])) {
                throw new RuntimeException('Dry run blocked: ' . self::feedUnavailableMessage($report));
            }
            if (empty($report['pre_cleanup_safe'])) {
                throw new RuntimeException(
                    'Dry run blocked: live data is not the exact reviewed 232-feed/237-post five-pair state'
                );
            }

            $pairs = [];
            foreach ($report['reviewed_identities'] as $finding) {
                $canonical = $finding['canonical_record'];
                $noncanonical = $finding['noncanonical_records'];
                if (
                    $canonical === null
                    || $canonical['status'] !== 'publish'
                    || count($finding['records']) !== 2
                    || count($noncanonical) !== 1
                ) {
                    throw new RuntimeException(
                        'Dry run blocked: ' . $finding['feed_id'] . ' is not one published survivor plus one noncanonical post'
                    );
                }
                $pairs[] = [
                    'organisation' => self::REVIEWED_IDENTITIES[$finding['feed_id']],
                    'feed_id' => $finding['feed_id'],
                    'survivor_post_id' => (int) $canonical['wp_post_id'],
                    'noncanonical_post_ids' => [(int) $noncanonical[0]['wp_post_id']],
                    'action' => 'delete',
                    'survivor' => $canonical,
                    'noncanonical' => $noncanonical,
                ];
            }

            return [
                'generated_at' => gmdate('c'),
                'source_identity_signature' => $report['identity_signature'],
                'pairs' => $pairs,
            ];
        }

        public static function validateLivePlan($plan, $report)
        {
            if (!is_array($plan) || !isset($plan['pairs']) || count($plan['pairs']) !== count(self::REVIEWED_IDENTITIES)) {
                throw new RuntimeException('Apply requires exactly all five reviewed identity pairs');
            }
            if (empty($report['feed']['available'])) {
                throw new RuntimeException('Apply blocked: ' . self::feedUnavailableMessage($report));
            }
            if (
                empty($plan['source_identity_signature'])
                || empty($report['identity_signature'])
                || !hash_equals((string) $plan['source_identity_signature'], (string) $report['identity_signature'])
            ) {
                throw new RuntimeException('Live feed or WordPress identity sets changed after dry run');
            }
            if (empty($report['pre_cleanup_safe'])) {
                throw new RuntimeException('Live data no longer passes the exact pre-cleanup safety gates');
            }

            $seen = [];
            foreach ($plan['pairs'] as $pair) {
                $feed_id = trim((string) ($pair['feed_id'] ?? ''));
                $survivor_id = (int) ($pair['survivor_post_id'] ?? 0);
                $noncanonical_ids = array_values(array_unique(array_map('intval', $pair['noncanonical_post_ids'] ?? [])));
                sort($noncanonical_ids, SORT_NUMERIC);
                if (!isset(self::REVIEWED_IDENTITIES[$feed_id]) || isset($seen[$feed_id])) {
                    throw new RuntimeException('Plan contains an unknown or repeated reviewed identity');
                }
                if (
                    ($pair['action'] ?? '') !== 'delete'
                    || $survivor_id <= 0
                    || count($noncanonical_ids) !== 1
                    || in_array($survivor_id, $noncanonical_ids, true)
                ) {
                    throw new RuntimeException('Plan contains an invalid or unsafe exact-ID deletion instruction');
                }

                $matches = self::findMatches($feed_id);
                $canonical = self::selectCanonical($matches);
                $live_ids = array_values(array_map(function ($post) {
                    return (int) $post->ID;
                }, $matches));
                sort($live_ids, SORT_NUMERIC);
                $planned_ids = array_merge([$survivor_id], $noncanonical_ids);
                sort($planned_ids, SORT_NUMERIC);
                if ($live_ids !== $planned_ids) {
                    throw new RuntimeException('Live post IDs changed for reviewed identity ' . $feed_id);
                }
                if (
                    $canonical === null
                    || (int) $canonical->ID !== $survivor_id
                    || $canonical->post_status !== 'publish'
                ) {
                    throw new RuntimeException('The approved survivor is missing, changed, or unpublished for ' . $feed_id);
                }
                $seen[$feed_id] = true;
            }
            if (count($seen) !== count(self::REVIEWED_IDENTITIES)) {
                throw new RuntimeException('Plan does not contain all five reviewed identities');
            }
            return true;
        }

        private static function clearOptionCache($option_name)
        {
            wp_cache_delete($option_name, 'options');
            wp_cache_delete('alloptions', 'options');
        }

        private static function readOptionRow($option_name)
        {
            global $wpdb;
            $raw = $wpdb->get_var($wpdb->prepare(
                "SELECT option_value FROM {$wpdb->options} WHERE option_name = %s LIMIT 1",
                $option_name
            ));
            if ($raw === null) {
                return null;
            }
            return [
                'raw' => (string) $raw,
                'value' => maybe_unserialize($raw),
            ];
        }

        private static function compareAndSwapOption($option_name, $expected_raw, $replacement)
        {
            global $wpdb;
            $updated = $wpdb->query($wpdb->prepare(
                "UPDATE {$wpdb->options}
                 SET option_value = %s
                 WHERE option_name = %s AND option_value = %s",
                maybe_serialize($replacement),
                $option_name,
                $expected_raw
            ));
            if ($updated === 1) {
                self::clearOptionCache($option_name);
                return true;
            }
            return false;
        }

        private static function compareAndDeleteOption($option_name, $expected_raw)
        {
            global $wpdb;
            $deleted = $wpdb->query($wpdb->prepare(
                "DELETE FROM {$wpdb->options}
                 WHERE option_name = %s AND option_value = %s",
                $option_name,
                $expected_raw
            ));
            if ($deleted === 1) {
                self::clearOptionCache($option_name);
                return true;
            }
            return false;
        }

        private static function acquireDatabaseLock()
        {
            global $wpdb;
            $acquired = $wpdb->get_var($wpdb->prepare(
                'SELECT GET_LOCK(%s, %d)',
                self::DB_LOCK_NAME,
                0
            ));
            return (string) $acquired === '1';
        }

        private static function databaseLockIsOwned()
        {
            global $wpdb;
            $owned = $wpdb->get_var($wpdb->prepare(
                'SELECT IF(IS_USED_LOCK(%s) = CONNECTION_ID(), 1, 0)',
                self::DB_LOCK_NAME
            ));
            return (string) $owned === '1';
        }

        private static function releaseDatabaseLock()
        {
            global $wpdb;
            $wpdb->get_var($wpdb->prepare(
                'SELECT RELEASE_LOCK(%s)',
                self::DB_LOCK_NAME
            ));
        }

        private static function acquireLock()
        {
            if (!self::acquireDatabaseLock()) {
                $row = self::readOptionRow(self::LOCK_OPTION);
                $current = is_array($row['value'] ?? null) ? $row['value'] : [];
                $busy_until = (int) ($current['expires_at'] ?? 0);
                throw new RuntimeException(
                    'Member sync/cleanup database lock is already held'
                    . ($busy_until > 0 ? ' (option lease until ' . gmdate('c', $busy_until) . ')' : '')
                );
            }
            try {
                return self::acquireOptionLock();
            } catch (Throwable $error) {
                self::releaseDatabaseLock();
                throw $error;
            }
        }

        private static function acquireOptionLock()
        {
            $now = time();
            $token = function_exists('wp_generate_uuid4')
                ? wp_generate_uuid4()
                : uniqid('gsf-browser-cleanup-', true);
            $lock = [
                'token' => $token,
                'acquired_at' => $now,
                'expires_at' => $now + self::LOCK_TTL,
                'owner' => 'reviewed_duplicate_browser_cleanup',
            ];
            if (add_option(self::LOCK_OPTION, $lock, '', false)) {
                return $lock;
            }

            $row = self::readOptionRow(self::LOCK_OPTION);
            if ($row === null) {
                if (add_option(self::LOCK_OPTION, $lock, '', false)) {
                    return $lock;
                }
                $row = self::readOptionRow(self::LOCK_OPTION);
            }
            $current = is_array($row['value'] ?? null) ? $row['value'] : [];
            if ((int) ($current['expires_at'] ?? 0) <= $now) {
                if (self::compareAndSwapOption(self::LOCK_OPTION, $row['raw'], $lock)) {
                    return $lock;
                }
                $row = self::readOptionRow(self::LOCK_OPTION);
                $current = is_array($row['value'] ?? null) ? $row['value'] : [];
            }
            $busy_until = (int) ($current['expires_at'] ?? 0);
            throw new RuntimeException(
                'Member sync/cleanup is already running'
                . ($busy_until > 0 ? ' until ' . gmdate('c', $busy_until) : '')
            );
        }

        private static function renewLock(&$lock)
        {
            $row = self::readOptionRow(self::LOCK_OPTION);
            $current = is_array($row['value'] ?? null) ? $row['value'] : [];
            if (
                $row === null
                || !isset($current['token'])
                || !hash_equals((string) $current['token'], (string) ($lock['token'] ?? ''))
                || (int) ($current['expires_at'] ?? 0) <= time()
            ) {
                throw new RuntimeException('Member sync/cleanup lease ownership was lost or expired');
            }
            $replacement = $current;
            $replacement['expires_at'] = max(
                time() + self::LOCK_TTL,
                (int) ($current['expires_at'] ?? 0) + 1
            );
            if (!self::compareAndSwapOption(self::LOCK_OPTION, $row['raw'], $replacement)) {
                throw new RuntimeException('Member sync/cleanup lease renewal lost a concurrent race');
            }
            $lock = $replacement;
        }

        private static function assertLockOwnedAndUnexpired($lock)
        {
            $row = self::readOptionRow(self::LOCK_OPTION);
            $current = is_array($row['value'] ?? null) ? $row['value'] : [];
            if (
                !self::databaseLockIsOwned()
                ||
                $row === null
                || !isset($current['token'])
                || !hash_equals((string) $current['token'], (string) ($lock['token'] ?? ''))
                || (int) ($current['expires_at'] ?? 0) <= time()
            ) {
                throw new RuntimeException('Destructive action blocked because the member sync/cleanup lease is not currently owned');
            }
        }

        private static function releaseLock($token)
        {
            try {
                $row = self::readOptionRow(self::LOCK_OPTION);
                $current = is_array($row['value'] ?? null) ? $row['value'] : [];
                if (
                    $row === null
                    || !isset($current['token'])
                    || !hash_equals((string) $current['token'], (string) $token)
                ) {
                    return;
                }
                self::compareAndDeleteOption(self::LOCK_OPTION, $row['raw']);
            } finally {
                self::releaseDatabaseLock();
            }
        }

        private static function evidenceKey($user_id)
        {
            return 'gsf_cleanup_evidence_' . (int) $user_id;
        }

        private static function journalKey($user_id)
        {
            return 'gsf_cleanup_journal_' . (int) $user_id;
        }

        private static function appendJournalEvent($user_id, $run_token, $event_type, $apply, $after = null)
        {
            $key = self::journalKey($user_id);
            $run_id = substr(hash('sha256', (string) $run_token), 0, 24);
            $journal = get_option($key, []);
            if (!is_array($journal) || ($journal['run_id'] ?? '') !== $run_id) {
                $journal = [
                    'run_id' => $run_id,
                    'user_id' => (int) $user_id,
                    'started_at' => gmdate('c'),
                    'events' => [],
                ];
            }
            $sequence = count($journal['events']) + 1;
            $event = [
                'sequence' => $sequence,
                'recorded_at' => gmdate('c'),
                'type' => (string) $event_type,
                'apply' => $apply,
                'after' => $after,
            ];
            $journal['events'][] = $event;
            $journal['updated_at'] = $event['recorded_at'];
            update_option($key, $journal);

            $stored = get_option($key, []);
            $stored_events = is_array($stored) && isset($stored['events']) && is_array($stored['events'])
                ? $stored['events']
                : [];
            $stored_last = empty($stored_events) ? null : $stored_events[count($stored_events) - 1];
            if (
                !is_array($stored_last)
                || (int) ($stored_last['sequence'] ?? 0) !== $sequence
                || ($stored_last['type'] ?? '') !== $event_type
            ) {
                throw new RuntimeException('Cleanup audit journal could not be persisted; no further deletion is allowed');
            }
            return $stored;
        }

        private static function loadEvidence($user_id)
        {
            $evidence = get_transient(self::evidenceKey($user_id));
            if (is_array($evidence)) {
                return $evidence;
            }
            $evidence = [];
            $journal = get_option(self::journalKey($user_id), []);
            $events = is_array($journal) && isset($journal['events']) && is_array($journal['events'])
                ? $journal['events']
                : [];
            if (!empty($events)) {
                $last = $events[count($events) - 1];
                if (empty($evidence['apply']) && !empty($last['apply'])) {
                    $evidence['apply'] = $last['apply'];
                }
                if (empty($evidence['after']) && !empty($last['after'])) {
                    $evidence['after'] = $last['after'];
                }
            }
            return $evidence;
        }

        private static function ticketOptionName($token)
        {
            return 'gsf_cleanup_ticket_' . substr(hash('sha256', (string) $token), 0, 40);
        }

        private static function createTicket($user_id, $plan, $identity_snapshot)
        {
            for ($attempt = 0; $attempt < 3; $attempt++) {
                $token = function_exists('wp_generate_uuid4')
                    ? wp_generate_uuid4()
                    : uniqid('gsf-cleanup-ticket-', true);
                $ticket = [
                    'token' => $token,
                    'user_id' => (int) $user_id,
                    'created_at' => time(),
                    'expires_at' => time() + self::EVIDENCE_TTL,
                    'plan' => $plan,
                    'identity_snapshot' => $identity_snapshot,
                ];
                if (add_option(self::ticketOptionName($token), $ticket, '', false)) {
                    return $token;
                }
            }
            throw new RuntimeException('Could not create a one-time cleanup plan ticket');
        }

        private static function claimTicket($user_id, $token)
        {
            if (!is_string($token) || !preg_match('/^[A-Za-z0-9._-]{8,200}$/', $token)) {
                throw new RuntimeException('Cleanup plan ticket is invalid');
            }
            $option_name = self::ticketOptionName($token);
            $row = self::readOptionRow($option_name);
            $ticket = is_array($row['value'] ?? null) ? $row['value'] : [];
            if (
                $row === null
                || !isset($ticket['token'])
                || !hash_equals((string) $ticket['token'], $token)
                || (int) ($ticket['user_id'] ?? 0) !== (int) $user_id
                || (int) ($ticket['expires_at'] ?? 0) < time()
            ) {
                throw new RuntimeException('Cleanup plan ticket is invalid, expired, or already used');
            }
            if (!self::compareAndDeleteOption($option_name, $row['raw'])) {
                throw new RuntimeException('Cleanup plan ticket was already claimed by another request');
            }
            return $ticket;
        }

        private static function invalidateTicket($user_id, $token)
        {
            if (!is_string($token) || !preg_match('/^[A-Za-z0-9._-]{8,200}$/', $token)) {
                return;
            }
            $option_name = self::ticketOptionName($token);
            $row = self::readOptionRow($option_name);
            $ticket = is_array($row['value'] ?? null) ? $row['value'] : [];
            if (
                $row !== null
                && isset($ticket['token'])
                && hash_equals((string) $ticket['token'], $token)
                && (int) ($ticket['user_id'] ?? 0) === (int) $user_id
            ) {
                self::compareAndDeleteOption($option_name, $row['raw']);
            }
        }

        public static function validateBrowserRequest($operation, $method, $can_manage, $nonce_valid, $confirmed)
        {
            if (!$can_manage) {
                throw new RuntimeException('Administrator permission is required');
            }
            if (strtoupper((string) $method) !== 'POST') {
                throw new RuntimeException('Cleanup actions require an authenticated POST request');
            }
            if (!in_array($operation, ['dry-run', 'apply'], true)) {
                throw new RuntimeException('Unknown cleanup action');
            }
            if (!$nonce_valid) {
                throw new RuntimeException('Cleanup security token is invalid or expired');
            }
            if ($operation === 'apply' && !$confirmed) {
                throw new RuntimeException('Permanent cleanup requires the checkbox and exact confirmation phrase');
            }
            return true;
        }

        /**
         * Execute the same authenticated controller path used by admin-post.php,
         * without redirecting. Kept public for the browser-path regression
         * harness; callers cannot bypass WordPress capability or nonce checks.
         */
        public static function processBrowserPost($source, $method)
        {
            $operation = sanitize_key((string) self::requestValue($source, 'operation'));
            $token = (string) self::requestValue($source, 'plan_token');
            $nonce = (string) self::requestValue($source, '_gsf_cleanup_nonce');
            $nonce_action = $operation === 'apply'
                ? self::APPLY_NONCE_PREFIX . $token
                : self::DRY_RUN_NONCE_ACTION;
            $nonce_valid = $nonce !== '' && wp_verify_nonce($nonce, $nonce_action);
            $confirmed = self::requestValue($source, 'confirm_delete') === '1'
                && hash_equals(
                    self::CONFIRMATION_PHRASE,
                    trim((string) self::requestValue($source, 'confirmation_phrase'))
                );

            self::validateBrowserRequest(
                $operation,
                $method,
                current_user_can('manage_options'),
                $nonce_valid,
                $confirmed
            );
            return $operation === 'dry-run'
                ? self::performDryRun((int) get_current_user_id())
                : self::performApply((int) get_current_user_id(), $token);
        }

        public static function getDownloadPayload($phase, $user_id, $can_manage, $nonce_valid)
        {
            if (!$can_manage) {
                throw new RuntimeException('Administrator permission is required');
            }
            if (!in_array($phase, ['before', 'dry_run', 'apply', 'after'], true)) {
                throw new RuntimeException('Unknown cleanup evidence phase');
            }
            if (!$nonce_valid) {
                throw new RuntimeException('Cleanup evidence security token is invalid or expired');
            }
            $evidence = self::loadEvidence($user_id);
            if (empty($evidence[$phase])) {
                throw new RuntimeException('That cleanup evidence is no longer available');
            }
            return $evidence[$phase];
        }

        public static function performDryRun($user_id)
        {
            $lock = self::acquireLock();
            try {
                $before = self::buildInventoryReport();
                $plan = self::buildDeletionPlan($before);
                $previous_evidence = get_transient(self::evidenceKey($user_id));
                if (is_array($previous_evidence) && !empty($previous_evidence['active_token'])) {
                    self::invalidateTicket($user_id, (string) $previous_evidence['active_token']);
                }
                $token = self::createTicket($user_id, $plan, $before['identity_snapshot']);
                $dry_run = [
                    'generated_at' => gmdate('c'),
                    'mode' => 'dry-run',
                    'applied' => false,
                    'message' => 'No member post was changed. Review this exact five-ID deletion plan before applying.',
                    'plan' => $plan,
                ];
                $evidence = [
                    'before' => $before,
                    'dry_run' => $dry_run,
                    'apply' => null,
                    'after' => null,
                    'active_token' => $token,
                    'last_error' => null,
                ];
                set_transient(self::evidenceKey($user_id), $evidence, self::EVIDENCE_TTL);
                return $evidence;
            } finally {
                self::releaseLock($lock['token']);
            }
        }

        public static function performApply($user_id, $token)
        {
            $ticket = self::claimTicket($user_id, $token);
            $existing_evidence = get_transient(self::evidenceKey($user_id));
            if (!is_array($existing_evidence)) {
                $existing_evidence = [];
            }
            $existing_evidence['active_token'] = null;
            $apply = [
                'generated_at' => gmdate('c'),
                'mode' => 'apply',
                'applied' => false,
                'acceptance_passed' => false,
                'plan' => $ticket['plan'],
                'attempts' => [],
                'error' => null,
            ];
            $after = null;
            $lock = null;
            $deleted_post_ids = [];
            $existing_evidence['apply'] = $apply;
            $existing_evidence['after'] = null;
            $existing_evidence['last_error'] = null;
            set_transient(self::evidenceKey($user_id), $existing_evidence, self::EVIDENCE_TTL);
            self::appendJournalEvent($user_id, $token, 'apply_started', $apply);

            try {
                $lock = self::acquireLock();
                $live_before_apply = self::buildInventoryReport();
                self::validateLivePlan($ticket['plan'], $live_before_apply);

                foreach ($ticket['plan']['pairs'] as $pair) {
                    $feed_id = (string) $pair['feed_id'];
                    $survivor_id = (int) $pair['survivor_post_id'];
                    $post_id = (int) $pair['noncanonical_post_ids'][0];
                    self::renewLock($lock);

                    $stage_report = self::buildInventoryReport();
                    if (empty($stage_report['feed']['available'])) {
                        throw new RuntimeException(
                            'Apply blocked before deleting post ' . $post_id . ': '
                            . self::feedUnavailableMessage($stage_report)
                        );
                    }
                    $expected_snapshot = self::identitySnapshotAfterDeletions(
                        $ticket['identity_snapshot'] ?? [],
                        $deleted_post_ids
                    );
                    $expected_signature = self::identitySignature($expected_snapshot);
                    if (
                        empty($stage_report['identity_signature'])
                        || !hash_equals($expected_signature, (string) $stage_report['identity_signature'])
                    ) {
                        throw new RuntimeException(
                            'Live feed or WordPress identity sets changed before deleting post ' . $post_id
                        );
                    }

                    $survivor = get_post($survivor_id);
                    $candidate = get_post($post_id);
                    if (
                        !$survivor
                        || $survivor->post_status !== 'publish'
                        || trim((string) get_post_meta($survivor_id, 'zoho_id', true)) !== $feed_id
                    ) {
                        throw new RuntimeException('Survivor protection check failed for post ' . $survivor_id);
                    }
                    if (
                        !$candidate
                        || $post_id === $survivor_id
                        || trim((string) get_post_meta($post_id, 'zoho_id', true)) !== $feed_id
                    ) {
                        throw new RuntimeException('Exact-ID deletion fence failed for post ' . $post_id);
                    }

                    $attempt = [
                        'feed_id' => $feed_id,
                        'survivor_post_id' => $survivor_id,
                        'wp_post_id' => $post_id,
                        'action' => 'delete_permanently',
                        'attempted_at' => gmdate('c'),
                        'result' => 'pending_delete',
                    ];
                    $apply['attempts'][] = $attempt;
                    $attempt_index = count($apply['attempts']) - 1;
                    $existing_evidence['apply'] = $apply;
                    set_transient(self::evidenceKey($user_id), $existing_evidence, self::EVIDENCE_TTL);
                    self::appendJournalEvent($user_id, $token, 'delete_pending', $apply);

                    try {
                        // This ownership/expiry fence is intentionally the final
                        // operation before the destructive WordPress call.
                        self::assertLockOwnedAndUnexpired($lock);
                    } catch (Throwable $lock_error) {
                        $apply['attempts'][$attempt_index]['result'] = 'blocked_before_delete';
                        $existing_evidence['apply'] = $apply;
                        set_transient(self::evidenceKey($user_id), $existing_evidence, self::EVIDENCE_TTL);
                        self::appendJournalEvent($user_id, $token, 'delete_blocked', $apply);
                        throw $lock_error;
                    }

                    $deleted = wp_delete_post($post_id, true);
                    if (!$deleted) {
                        $apply['attempts'][$attempt_index]['result'] = 'failed';
                        $existing_evidence['apply'] = $apply;
                        set_transient(self::evidenceKey($user_id), $existing_evidence, self::EVIDENCE_TTL);
                        self::appendJournalEvent($user_id, $token, 'delete_failed', $apply);
                        throw new RuntimeException('WordPress failed to permanently delete post ' . $post_id);
                    }
                    if (get_post($post_id)) {
                        $apply['attempts'][$attempt_index]['result'] = 'failed_still_present';
                        $existing_evidence['apply'] = $apply;
                        set_transient(self::evidenceKey($user_id), $existing_evidence, self::EVIDENCE_TTL);
                        self::appendJournalEvent($user_id, $token, 'delete_failed_still_present', $apply);
                        throw new RuntimeException('WordPress returned success but post ' . $post_id . ' is still present');
                    }
                    $apply['attempts'][$attempt_index]['result'] = 'deleted';
                    $apply['attempts'][$attempt_index]['completed_at'] = gmdate('c');
                    $deleted_post_ids[] = $post_id;
                    $existing_evidence['apply'] = $apply;
                    set_transient(self::evidenceKey($user_id), $existing_evidence, self::EVIDENCE_TTL);
                    self::appendJournalEvent($user_id, $token, 'delete_succeeded', $apply);
                }

                self::renewLock($lock);
                $after = self::buildInventoryReport();
                $expected_after = self::identitySnapshotAfterDeletions(
                    $ticket['identity_snapshot'] ?? [],
                    $deleted_post_ids
                );
                $expected_after_signature = self::identitySignature($expected_after);
                $apply['expected_final_identity_signature'] = $expected_after_signature;
                $apply['actual_final_identity_signature'] = (string) ($after['identity_signature'] ?? '');
                $apply['final_identity_snapshot_matched'] = $apply['actual_final_identity_signature'] !== ''
                    && hash_equals($expected_after_signature, $apply['actual_final_identity_signature']);
                $apply['applied'] = count($apply['attempts']) === count(self::REVIEWED_IDENTITIES);
                $apply['acceptance_passed'] = !empty($after['strict_clean'])
                    && $apply['final_identity_snapshot_matched'];
                if (!$apply['acceptance_passed']) {
                    $apply['error'] = !$apply['final_identity_snapshot_matched']
                        ? 'Deletion completed, but the final feed/WordPress survivor identity snapshot changed'
                        : 'Deletion completed, but the strict 232/232 post-cleanup reconciliation did not pass';
                }
            } catch (Throwable $error) {
                $apply['error'] = $error->getMessage();
                try {
                    $after = self::buildInventoryReport();
                } catch (Throwable $after_error) {
                    $after = [
                        'generated_at' => gmdate('c'),
                        'read_only' => true,
                        'error' => $after_error->getMessage(),
                    ];
                }
                try {
                    self::appendJournalEvent($user_id, $token, 'apply_error', $apply, $after);
                } catch (Throwable $journal_error) {
                    $apply['journal_error'] = $journal_error->getMessage();
                }
            } finally {
                if (is_array($lock) && isset($lock['token'])) {
                    self::releaseLock($lock['token']);
                }
            }

            $existing_evidence['apply'] = $apply;
            $existing_evidence['after'] = $after;
            $existing_evidence['last_error'] = $apply['error'];
            set_transient(self::evidenceKey($user_id), $existing_evidence, self::EVIDENCE_TTL);
            self::appendJournalEvent($user_id, $token, 'apply_finished', $apply, $after);
            return $existing_evidence;
        }

        private static function requestValue($source, $key)
        {
            $value = $source[$key] ?? '';
            return is_string($value) ? wp_unslash($value) : $value;
        }

        public static function handlePost()
        {
            $user_id = (int) get_current_user_id();
            $operation = sanitize_key((string) self::requestValue($_POST, 'operation'));
            try {
                self::processBrowserPost($_POST, $_SERVER['REQUEST_METHOD'] ?? '');
            } catch (Throwable $error) {
                $evidence = self::loadEvidence($user_id);
                $evidence['last_error'] = $error->getMessage();
                set_transient(self::evidenceKey($user_id), $evidence, self::EVIDENCE_TTL);
            }

            wp_safe_redirect(self::pageUrl());
            exit;
        }

        public static function handleDownload()
        {
            $phase = sanitize_key((string) self::requestValue($_GET, 'phase'));
            $nonce = (string) self::requestValue($_GET, '_wpnonce');
            try {
                $payload = self::getDownloadPayload(
                    $phase,
                    (int) get_current_user_id(),
                    current_user_can('manage_options'),
                    $nonce !== '' && wp_verify_nonce($nonce, self::DOWNLOAD_NONCE_PREFIX . $phase)
                );
            } catch (Throwable $error) {
                wp_die($error->getMessage(), '', ['response' => 403]);
            }

            nocache_headers();
            header('Content-Type: application/json; charset=utf-8');
            header('Content-Disposition: attachment; filename="gsf-member-cleanup-' . $phase . '-' . gmdate('Ymd-His') . '.json"');
            echo wp_json_encode($payload, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
            exit;
        }

        private static function pageUrl()
        {
            return admin_url('edit.php?post_type=gsf_member&page=' . self::PAGE_SLUG);
        }

        private static function renderGateTable($gates)
        {
            if (empty($gates) || !is_array($gates)) {
                return;
            }
            echo '<table class="widefat striped gsf-cleanup-gates"><thead><tr><th>Gate</th><th>Result</th><th>Detail</th></tr></thead><tbody>';
            foreach ($gates as $key => $gate) {
                $available = !isset($gate['available']) || !empty($gate['available']);
                $passed = !empty($gate['passed']);
                $label = !$available ? 'UNAVAILABLE' : ($passed ? 'PASS' : 'BLOCKED');
                $colour = !$available ? '#996800' : ($passed ? '#008a20' : '#b32d2e');
                echo '<tr>';
                echo '<td><code>' . esc_html($key) . '</code></td>';
                echo '<td><strong style="color:' . $colour . '">' . $label . '</strong></td>';
                echo '<td>' . esc_html($gate['detail'] ?? '') . '</td>';
                echo '</tr>';
            }
            echo '</tbody></table>';
        }

        private static function renderAcceptance($report)
        {
            if (is_array($report)) {
                self::renderGateTable($report['acceptance'] ?? []);
            }
        }

        private static function renderReviewedIdentities($report)
        {
            echo '<h2>Five reviewed stable identities</h2>';
            echo '<p>Identity is the exact stable feed ID, never the organisation title or the 237-versus-232 count.</p>';
            foreach ($report['reviewed_identities'] as $finding) {
                echo '<div class="postbox"><div class="inside">';
                echo '<h3>' . esc_html($finding['expected_name']) . ' <code>' . esc_html($finding['feed_id']) . '</code></h3>';
                echo '<table class="widefat striped"><thead><tr>'
                    . '<th>Role</th><th>WordPress post ID</th><th>Status</th><th>Title</th>'
                    . '<th>Created</th><th>Modified</th><th>Per-record sync</th></tr></thead><tbody>';
                if (empty($finding['records'])) {
                    echo '<tr><td colspan="7"><strong>No WordPress record found.</strong></td></tr>';
                }
                $canonical_id = (int) ($finding['canonical_record']['wp_post_id'] ?? 0);
                foreach ($finding['records'] as $record) {
                    $is_canonical = (int) $record['wp_post_id'] === $canonical_id;
                    echo '<tr>';
                    echo '<td><strong>' . ($is_canonical ? 'Canonical survivor' : 'Noncanonical deletion candidate') . '</strong></td>';
                    echo '<td><code>' . (int) $record['wp_post_id'] . '</code></td>';
                    echo '<td>' . esc_html($record['status']) . '</td>';
                    echo '<td>' . esc_html($record['name']) . '</td>';
                    echo '<td>' . esc_html($record['created_at']) . '</td>';
                    echo '<td>' . esc_html($record['modified_at']) . '</td>';
                    echo '<td>' . esc_html($record['last_sync'] === '' ? 'Not recorded' : $record['last_sync']) . '</td>';
                    echo '</tr>';
                }
                echo '</tbody></table></div></div>';
            }
        }

        private static function renderEvidence($evidence)
        {
            $labels = [
                'before' => 'Before report',
                'dry_run' => 'Dry-run deletion plan',
                'apply' => 'Apply log',
                'after' => 'After report',
            ];
            $shown = false;
            foreach ($labels as $phase => $label) {
                if (empty($evidence[$phase])) {
                    continue;
                }
                if (!$shown) {
                    echo '<h2>Deployment evidence</h2>';
                    echo '<p>Copy each JSON block or download it before removing this temporary interface.</p>';
                    $shown = true;
                }
                $url = wp_nonce_url(
                    add_query_arg([
                        'action' => self::DOWNLOAD_ACTION,
                        'phase' => $phase,
                    ], admin_url('admin-post.php')),
                    self::DOWNLOAD_NONCE_PREFIX . $phase
                );
                echo '<h3>' . esc_html($label) . ' <a class="button button-small" href="' . esc_url($url) . '">Download JSON</a></h3>';
                echo '<textarea readonly rows="12" style="width:100%;font-family:monospace;">'
                    . esc_textarea(wp_json_encode($evidence[$phase], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES))
                    . '</textarea>';
            }
        }

        public static function renderPage()
        {
            if (!current_user_can('manage_options')) {
                wp_die('Administrator permission is required.', '', ['response' => 403]);
            }
            $user_id = (int) get_current_user_id();
            $evidence = self::loadEvidence($user_id);
            try {
                $live_report = self::buildInventoryReport();
                $live_error = null;
            } catch (Throwable $error) {
                $live_report = null;
                $live_error = $error->getMessage();
            }
            ?>
            <div class="wrap">
                <h1>Reviewed Member Duplicate Cleanup</h1>
                <div class="notice notice-warning inline">
                    <p><strong>Temporary destructive administration tool.</strong>
                        Normal member sync never deletes these duplicates. Apply permanently deletes only the exact
                        noncanonical post IDs captured by a fresh dry run.</p>
                </div>

                <?php if (!empty($evidence['last_error'])): ?>
                    <div class="notice notice-error inline"><p><strong>Cleanup blocked:</strong>
                        <?php echo esc_html($evidence['last_error']); ?></p></div>
                <?php endif; ?>
                <?php if ($live_error !== null): ?>
                    <div class="notice notice-error inline"><p><strong>Live inventory failed:</strong>
                        <?php echo esc_html($live_error); ?></p></div>
                <?php else: ?>
                    <?php if (empty($live_report['feed']['available'])): ?>
                        <div class="notice notice-error inline">
                            <p><strong>Configured iConnect feed reconciliation is unavailable.</strong></p>
                            <p><strong>Source:</strong> <code><?php echo esc_html($live_report['feed']['source'] ?? 'unknown'); ?></code><br>
                                <strong>Error:</strong> <?php echo esc_html($live_report['feed']['error'] ?? 'Unknown feed error'); ?></p>
                            <p>Stale, orphan, and missing-ID findings are marked unavailable rather than being calculated
                                against an empty feed. Dry run and apply remain blocked until a trustworthy feed is obtained.</p>
                            <p><a class="button button-primary" href="<?php echo esc_url(
                                GSF_Iconnect_Feed_Settings_Admin::pageUrl()
                            ); ?>">Configure and test the iConnect feed</a></p>
                        </div>
                    <?php else: ?>
                        <div class="notice notice-info inline"><p><strong>Configured feed source:</strong>
                            <code><?php echo esc_html($live_report['feed']['source']); ?></code></p></div>
                    <?php endif; ?>
                    <?php if (!empty($live_report['strict_clean'])): ?>
                        <div class="notice notice-success inline"><p><strong>Strict cleanup acceptance passed:</strong>
                            232 configured feed records, 232 published WordPress members, and no duplicate, blank,
                            stale, orphan, or missing stable IDs.</p></div>
                    <?php endif; ?>

                    <h2>Live all-status reconciliation</h2>
                    <p><strong>WordPress counts:</strong>
                        <?php echo (int) ($live_report['wordpress']['published_posts'] ?? 0); ?> raw published posts;
                        <?php echo (int) ($live_report['wordpress']['published_unique_nonblank_ids'] ?? 0); ?>
                        unique published stable identities;
                        <?php echo (int) ($live_report['wordpress']['raw_posts'] ?? 0); ?> all-status posts.</p>
                    <?php self::renderAcceptance($live_report); ?>
                    <?php self::renderReviewedIdentities($live_report); ?>

                    <?php if (empty($live_report['strict_clean'])): ?>
                        <h2>Step 1 — Non-mutating dry run</h2>
                        <?php self::renderGateTable($live_report['pre_cleanup_checks'] ?? []); ?>
                        <p>This obtains the same token-fenced lease used by member syncs, captures the before report,
                            and creates a one-time exact-ID plan. It does not edit, trash, or delete a member post.</p>
                        <?php if (!empty($live_report['pre_cleanup_safe'])): ?>
                            <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>">
                                <input type="hidden" name="action" value="<?php echo esc_attr(self::POST_ACTION); ?>">
                                <input type="hidden" name="operation" value="dry-run">
                                <?php wp_nonce_field(self::DRY_RUN_NONCE_ACTION, '_gsf_cleanup_nonce'); ?>
                                <?php submit_button('Generate fresh dry run', 'secondary', 'submit', false); ?>
                            </form>
                        <?php else: ?>
                            <div class="notice notice-error inline"><p><strong>Dry run is unavailable.</strong>
                                Resolve the blocked pre-cleanup checks; this tool will not create a deletion plan
                                from an ambiguous or unexpected live inventory.</p></div>
                        <?php endif; ?>
                    <?php endif; ?>
                <?php endif; ?>

                <?php if (!empty($evidence['active_token']) && !empty($evidence['dry_run']['plan'])): ?>
                    <h2>Step 2 — Explicit permanent cleanup</h2>
                    <div class="notice notice-error inline"><p><strong>This cannot be undone from this screen.</strong>
                        The one-time plan will be consumed even if apply is blocked. Run another dry run to retry.</p></div>
                    <table class="widefat striped">
                        <thead><tr><th>Stable feed ID</th><th>Published survivor</th><th>Permanent deletion candidate</th></tr></thead>
                        <tbody>
                        <?php foreach ($evidence['dry_run']['plan']['pairs'] as $pair): ?>
                            <tr>
                                <td><code><?php echo esc_html($pair['feed_id']); ?></code></td>
                                <td><code><?php echo (int) $pair['survivor_post_id']; ?></code>
                                    (<?php echo esc_html($pair['survivor']['status'] ?? 'unknown'); ?>)</td>
                                <td><code><?php echo (int) $pair['noncanonical_post_ids'][0]; ?></code>
                                    (<?php echo esc_html($pair['noncanonical'][0]['status'] ?? 'unknown'); ?>)</td>
                            </tr>
                        <?php endforeach; ?>
                        </tbody>
                    </table>
                    <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>" style="margin-top:16px;">
                        <input type="hidden" name="action" value="<?php echo esc_attr(self::POST_ACTION); ?>">
                        <input type="hidden" name="operation" value="apply">
                        <input type="hidden" name="plan_token" value="<?php echo esc_attr($evidence['active_token']); ?>">
                        <?php wp_nonce_field(
                            self::APPLY_NONCE_PREFIX . $evidence['active_token'],
                            '_gsf_cleanup_nonce'
                        ); ?>
                        <p><label><input type="checkbox" name="confirm_delete" value="1">
                            I understand the five listed noncanonical WordPress posts will be permanently deleted.</label></p>
                        <p><label>Type <code><?php echo esc_html(self::CONFIRMATION_PHRASE); ?></code><br>
                            <input type="text" name="confirmation_phrase" class="regular-text" autocomplete="off"></label></p>
                        <?php submit_button('Permanently delete the five reviewed copies', 'delete', 'submit', false); ?>
                    </form>
                <?php endif; ?>

                <?php self::renderEvidence($evidence); ?>
            </div>
            <?php
        }
    }
}

if (function_exists('add_action')) {
    GSF_Iconnect_Feed_Settings_Admin::register();
    GSF_Reviewed_Duplicate_Cleanup_Admin::register();
}
