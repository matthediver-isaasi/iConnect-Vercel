<?php
if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
    exit;
}

delete_option( 'iconnect_sync_api_url' );
delete_option( 'iconnect_sync_api_key' );
delete_option( 'iconnect_sync_frequency' );
delete_option( 'iconnect_sync_last_status' );

$posts = get_posts( array(
    'post_type'      => 'iconnect_article',
    'posts_per_page' => -1,
    'post_status'    => 'any',
    'fields'         => 'ids',
) );

foreach ( $posts as $post_id ) {
    wp_delete_post( $post_id, true );
}

global $wpdb;
$wpdb->query( "DELETE FROM {$wpdb->termmeta} WHERE term_id IN (SELECT term_id FROM {$wpdb->term_taxonomy} WHERE taxonomy = 'iconnect_tag')" );
$wpdb->query( "DELETE FROM {$wpdb->term_relationships} WHERE term_taxonomy_id IN (SELECT term_taxonomy_id FROM {$wpdb->term_taxonomy} WHERE taxonomy = 'iconnect_tag')" );
$wpdb->query( "DELETE FROM {$wpdb->term_taxonomy} WHERE taxonomy = 'iconnect_tag'" );

flush_rewrite_rules();
