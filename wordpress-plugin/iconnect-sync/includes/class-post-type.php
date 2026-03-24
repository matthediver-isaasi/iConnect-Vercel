<?php
if ( ! defined( 'ABSPATH' ) ) {
    exit;
}

class IConnect_Sync_Post_Type {

    public function __construct() {
        add_action( 'admin_notices', array( $this, 'synced_post_notice' ) );
    }

    public function ensure_sync_category() {
        $cat_id = get_option( 'iconnect_sync_category', 0 );

        if ( $cat_id && term_exists( (int) $cat_id, 'category' ) ) {
            return $cat_id;
        }

        $existing = get_term_by( 'name', 'iConnect', 'category' );
        if ( $existing ) {
            update_option( 'iconnect_sync_category', $existing->term_id );
            return $existing->term_id;
        }

        $result = wp_insert_term( 'iConnect', 'category', array(
            'description' => __( 'Articles synced from iConnect.', 'iconnect-sync' ),
            'slug'        => 'iconnect',
        ) );

        if ( ! is_wp_error( $result ) ) {
            update_option( 'iconnect_sync_category', $result['term_id'] );
            return $result['term_id'];
        }

        return 0;
    }

    public function migrate_legacy_posts() {
        $migrated = get_option( 'iconnect_sync_migrated_to_posts', false );
        if ( $migrated ) {
            return;
        }

        global $wpdb;

        $legacy_posts = $wpdb->get_results(
            "SELECT ID FROM {$wpdb->posts} WHERE post_type = 'iconnect_article'",
            ARRAY_A
        );

        if ( ! empty( $legacy_posts ) ) {
            $cat_id = $this->ensure_sync_category();

            foreach ( $legacy_posts as $row ) {
                $post_id = (int) $row['ID'];

                $wpdb->update(
                    $wpdb->posts,
                    array( 'post_type' => 'post' ),
                    array( 'ID' => $post_id ),
                    array( '%s' ),
                    array( '%d' )
                );

                update_post_meta( $post_id, '_iconnect_synced', '1' );

                if ( $cat_id ) {
                    wp_set_post_categories( $post_id, array( $cat_id ), true );
                }

                $old_tags = wp_get_object_terms( $post_id, 'iconnect_tag', array( 'fields' => 'names' ) );
                if ( ! empty( $old_tags ) && ! is_wp_error( $old_tags ) ) {
                    wp_set_post_tags( $post_id, $old_tags, true );
                    wp_set_object_terms( $post_id, array(), 'iconnect_tag' );
                }
            }
        }

        $wpdb->query( "DELETE FROM {$wpdb->termmeta} WHERE term_id IN (SELECT term_id FROM {$wpdb->term_taxonomy} WHERE taxonomy = 'iconnect_tag')" );
        $wpdb->query( "DELETE FROM {$wpdb->term_relationships} WHERE term_taxonomy_id IN (SELECT term_taxonomy_id FROM {$wpdb->term_taxonomy} WHERE taxonomy = 'iconnect_tag')" );
        $wpdb->query( "DELETE FROM {$wpdb->term_taxonomy} WHERE taxonomy = 'iconnect_tag'" );

        update_option( 'iconnect_sync_migrated_to_posts', '1' );
    }

    public function synced_post_notice() {
        $screen = get_current_screen();
        if ( ! $screen || 'post' !== $screen->base ) {
            return;
        }

        $post_id = isset( $_GET['post'] ) ? (int) $_GET['post'] : 0;
        if ( ! $post_id ) {
            return;
        }

        $is_synced = get_post_meta( $post_id, '_iconnect_synced', true );
        if ( ! $is_synced ) {
            return;
        }

        $iconnect_url = get_post_meta( $post_id, '_iconnect_url', true );
        ?>
        <div class="notice notice-info is-dismissible">
            <p>
                <strong><?php esc_html_e( 'iConnect Synced Article', 'iconnect-sync' ); ?></strong> &mdash;
                <?php esc_html_e( 'This post is managed by iConnect and will be overwritten on the next sync. Edit the article in iConnect instead.', 'iconnect-sync' ); ?>
                <?php if ( ! empty( $iconnect_url ) ) : ?>
                    <a href="<?php echo esc_url( $iconnect_url ); ?>" target="_blank" rel="noopener noreferrer"><?php esc_html_e( 'View on iConnect', 'iconnect-sync' ); ?></a>
                <?php endif; ?>
            </p>
        </div>
        <?php
    }
}
