<?php

$GLOBALS['stats_test_countries'] = [];

class ZohoAPI
{
    public function getCountries()
    {
        return $GLOBALS['stats_test_countries'];
    }
}

function get_option($key, $default = false)
{
    return $default;
}

function stats_assert($condition, $message)
{
    if (!$condition) {
        fwrite(STDERR, "FAIL: {$message}\n");
        exit(1);
    }
    echo "ok - {$message}\n";
}

require dirname(__DIR__) . '/stats.iconnect.php';

stats_assert(
    GSF_MAP_STATS_VERSION === '1.1.0',
    'the corrected theme stats file exposes an explicit version'
);

$GLOBALS['stats_test_countries'] = [
    // Chile is selected by the tenant despite its current income label.
    'Chile' => [
        'flag' => ' Show ',
        'income_group' => 'High Income',
    ],
    // A legacy income label cannot make an unselected country eligible.
    'Uruguay' => [
        'flag' => 'Hide',
        'income_group' => 'Upper Middle Income',
    ],
    // Existing display-name aliases must remain intact.
    'Egypt, Arab Rep.' => [
        'flag' => 'SHOW',
        'income_group' => 'Lower Middle Income',
    ],
    'Malformed' => null,
];

$counts = gsf_get_map_country_counts([
    [
        'Account_Name' => 'Aptus',
        'Countries_of_Operation' => [
            'Dominican Republic',
            'Ecuador',
            'Mexico',
            'Chile',
            'Uruguay',
        ],
    ],
    [
        'Account_Name' => 'Alias member',
        'Countries_of_Operation' => ['Egypt, Arab Rep.'],
    ],
]);

stats_assert(
    ($counts['Chile'] ?? 0) === 1,
    'a tenant-selected Chile record is counted even when its income group is High Income'
);
stats_assert(
    !array_key_exists('Uruguay', $counts),
    'a hidden country is excluded even when it has a legacy eligible income group'
);
stats_assert(
    ($counts['Egypt'] ?? 0) === 1 && !array_key_exists('Egypt, Arab Rep.', $counts),
    'existing feed-to-map display aliases are preserved'
);
stats_assert(
    count($counts) === 2,
    'only flagged countries represented by member operations are returned'
);

echo "All iConnect map stats regression checks passed.\n";