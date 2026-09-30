<?php
/**
 * Community member/country stats and duo-text placeholders.
 *
 * iConnect handover replacement for:
 * wp-content/themes/global-schools-forum/core/members/stats.php
 */
define('GSF_MAP_STATS_VERSION', '1.2.0');

/**
 * iConnect country name aliases used for map counting and display.
 *
 * Keys are names as stored on member records; values are canonical country-feed names.
 * Only include a mapping here if the member-record value genuinely differs from the
 * country feed's name for that country.
 *
 * @return array<string, string>
 */
function gsf_get_country_name_overrides()
{
    return [
        'Congo, Dem. Rep.' => 'Democratic Republic of the Congo',
    ];
}

/**
 * Map a member country name to the canonical country-feed name when known.
 *
 * @param string $country_name
 * @return string
 */
function gsf_normalize_country_name($country_name)
{
    $country_name = is_string($country_name) ? trim($country_name) : '';
    if ($country_name === '') {
        return '';
    }

    $overrides = gsf_get_country_name_overrides();

    return $overrides[$country_name] ?? $country_name;
}

/**
 * Country-feed name => the name the front-end map library (CountryData in
 * js/modules/country-data.js) uses for the same country.
 *
 * The map's getCountryCode() does an exact (case-insensitive) name lookup, so any
 * feed name that differs from the JS list must be translated here or the country
 * silently fails to paint on the map. Only genuinely differing names need an entry.
 *
 * @return array<string, string>
 */
function gsf_get_map_display_name_overrides()
{
    return [
        'Czechia'          => 'Czech Republic',
        'Côte d’Ivoire'    => 'Ivory Coast',
        'Egypt, Arab Rep.' => 'Egypt',
        'Gambia, The'      => 'Gambia',
        'Kyrgyz Republic'  => 'Kyrgyzstan',
        'Lao PDR'          => 'Laos',
    ];
}

/**
 * Resolve a front-end map country label back to the canonical country-feed
 * name stored in member Countries_of_Operation metadata.
 *
 * This is the reverse of gsf_get_map_display_name_overrides(), matched
 * case-insensitively so the display and search paths cannot drift.
 *
 * @param string $country_name
 * @return string
 */
function gsf_resolve_map_search_country_name($country_name)
{
    $country_name = is_string($country_name) ? trim($country_name) : '';
    if ($country_name === '') {
        return '';
    }

    foreach (gsf_get_map_display_name_overrides() as $canonical_name => $display_name) {
        if (strcasecmp($country_name, $display_name) === 0) {
            return $canonical_name;
        }
    }

    return gsf_normalize_country_name($country_name);
}

/**
 * Build map country member counts using the same tenant-selected country
 * allow-list as member ingestion and the Multiple Locations tooltip.
 *
 * @param array|null $all_members Optional pre-loaded member list.
 * @return array<string, int> Country name => member count.
 */
function gsf_get_map_country_counts($all_members = null)
{
    if ($all_members === null) {
        if (get_option('gsf_use_test_data', false)) {
            $all_members = gsf_generate_test_members();
        } else {
            $zoho_result = gsf_get_members([
                'search' => '',
                'country' => '',
                'organization_type' => '',
                'page' => 1,
                'per_page' => -1,
            ]);
            $all_members = $zoho_result['members'] ?? [];
        }
    }

    $api = new ZohoAPI();
    $countries_data = $api->getCountries();

    // The configured iConnect Countries endpoint is authoritative: it resolves
    // the tenant's saved LMIC selection and emits Flag: Show only for selected
    // countries. Do not independently reclassify that list from Income_Group;
    // doing so excluded selected countries such as Chile from map shading while
    // search and tooltip metadata still included them.
    $eligible_countries = [];
    foreach ($countries_data as $country_name => $country_info) {
        $flag = is_array($country_info)
            ? strtolower(trim((string) ($country_info['flag'] ?? '')))
            : '';
        if ($flag === 'show') {
            $eligible_countries[$country_name] = $country_info;
        }
    }

    // Count against canonical country-feed names used by the eligibility lookup.
    $country_counts = [];
    foreach ($all_members as $member) {
        if (empty($member['Countries_of_Operation']) || !is_array($member['Countries_of_Operation'])) {
            continue;
        }

        foreach ($member['Countries_of_Operation'] as $country) {
            $country = gsf_normalize_country_name($country);
            if (!empty($country) && array_key_exists($country, $eligible_countries)) {
                if (!isset($country_counts[$country])) {
                    $country_counts[$country] = 0;
                }
                $country_counts[$country]++;
            }
        }
    }

    // Translate feed names to names understood by the front-end map library.
    $display_overrides = gsf_get_map_display_name_overrides();
    $display_counts = [];
    foreach ($country_counts as $country => $count) {
        $display_name = $display_overrides[$country] ?? $country;
        if (!isset($display_counts[$display_name])) {
            $display_counts[$display_name] = 0;
        }
        $display_counts[$display_name] += $count;
    }

    return $display_counts;
}

/**
 * Published member total and map country total for community copy.
 *
 * @return array{organisations: int, countries: int}
 */
function gsf_get_community_stats()
{
    $last_sync = (int) get_option('gsf_zoho_last_sync', 0);
    $cached = get_transient('gsf_community_stats');

    if (
        is_array($cached) &&
        isset($cached['organisations'], $cached['countries'], $cached['sync_time']) &&
        (int) $cached['sync_time'] === $last_sync
    ) {
        return [
            'organisations' => (int) $cached['organisations'],
            'countries' => (int) $cached['countries'],
        ];
    }

    $member_counts = wp_count_posts('gsf_member');
    $country_counts = gsf_get_map_country_counts();

    $stats = [
        'organisations' => (int) ($member_counts->publish ?? 0),
        'countries' => count($country_counts),
        'sync_time' => $last_sync,
    ];

    set_transient('gsf_community_stats', $stats, WEEK_IN_SECONDS);

    return [
        'organisations' => $stats['organisations'],
        'countries' => $stats['countries'],
    ];
}

/**
 * Replace {organisations} and {countries} placeholders in duo-text copy.
 *
 * @param string|null $text
 * @return string
 */
function gsf_replace_community_placeholders($text)
{
    if (!is_string($text) || $text === '') {
        return (string) $text;
    }

    if (strpos($text, '{organisations}') === false && strpos($text, '{countries}') === false) {
        return $text;
    }

    $stats = gsf_get_community_stats();

    return str_replace(
        ['{organisations}', '{countries}'],
        [(string) $stats['organisations'], (string) $stats['countries']],
        $text
    );
}

/**
 * Clear cached community stats after a member sync.
 */
function gsf_clear_community_stats_cache()
{
    delete_transient('gsf_community_stats');
}