<?php
if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
    exit;
}

delete_option( 'iconnect_sync_api_url' );
delete_option( 'iconnect_sync_api_key' );
delete_option( 'iconnect_sync_frequency' );
delete_option( 'iconnect_sync_category' );
delete_option( 'iconnect_sync_author' );
delete_option( 'iconnect_sync_last_status' );
delete_option( 'iconnect_sync_migrated_to_posts' );
delete_option( 'iconnect_sync_version' );

$synced_posts = get_posts( array(
    'post_type'      => 'post',
    'posts_per_page' => -1,
    'post_status'    => 'any',
    'meta_key'       => '_iconnect_synced',
    'meta_value'     => '1',
    'fields'         => 'ids',
) );

foreach ( $synced_posts as $post_id ) {
    wp_delete_post( $post_id, true );
}

flush_rewrite_rules();
