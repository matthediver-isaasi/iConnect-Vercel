<?php
if ( ! defined( 'ABSPATH' ) ) {
    exit;
}

class IConnect_Sync_Engine {

    public function __construct() {
        add_action( 'iconnect_sync_cron_event', array( $this, 'run_sync' ) );
        add_filter( 'cron_schedules', array( $this, 'add_cron_schedules' ) );
        add_action( 'update_option_iconnect_sync_frequency', array( $this, 'reschedule_sync' ), 10, 2 );
    }

    public function add_cron_schedules( $schedules ) {
        $schedules['iconnect_15min'] = array(
            'interval' => 900,
            'display'  => __( 'Every 15 Minutes', 'iconnect-sync' ),
        );
        return $schedules;
    }

    public function schedule_sync() {
        if ( ! wp_next_scheduled( 'iconnect_sync_cron_event' ) ) {
            $frequency = get_option( 'iconnect_sync_frequency', 'hourly' );
            wp_schedule_event( time(), $frequency, 'iconnect_sync_cron_event' );
        }
    }

    public function reschedule_sync( $old_value, $new_value ) {
        wp_clear_scheduled_hook( 'iconnect_sync_cron_event' );
        wp_schedule_event( time(), $new_value, 'iconnect_sync_cron_event' );
    }

    public function run_sync() {
        $api_url = get_option( 'iconnect_sync_api_url', '' );

        if ( empty( $api_url ) ) {
            $this->log_status( array(
                'last_run' => time(),
                'errors'   => array( 'iConnect API URL is not configured.' ),
            ) );
            return new WP_Error( 'no_api_url', __( 'iConnect API URL is not configured.', 'iconnect-sync' ) );
        }

        $api_url = trailingslashit( $api_url );
        $endpoint = $api_url . 'api/public/articles';

        $parsed = wp_parse_url( $api_url );
        $origin = $parsed['scheme'] . '://' . $parsed['host'];
        if ( ! empty( $parsed['port'] ) ) {
            $origin .= ':' . $parsed['port'];
        }

        $response = wp_remote_get( $endpoint, array(
            'timeout' => 30,
            'headers' => array(
                'Origin'       => $origin,
                'Content-Type' => 'application/json',
            ),
        ) );

        if ( is_wp_error( $response ) ) {
            $this->log_status( array(
                'last_run' => time(),
                'errors'   => array( 'API request failed: ' . $response->get_error_message() ),
            ) );
            return $response;
        }

        $code = wp_remote_retrieve_response_code( $response );
        if ( 200 !== $code ) {
            $this->log_status( array(
                'last_run' => time(),
                'errors'   => array( 'API returned HTTP ' . $code ),
            ) );
            return new WP_Error( 'api_error', sprintf( __( 'API returned HTTP %d', 'iconnect-sync' ), $code ) );
        }

        $body = json_decode( wp_remote_retrieve_body( $response ), true );

        if ( empty( $body ) || ! isset( $body['articles'] ) ) {
            $this->log_status( array(
                'last_run' => time(),
                'errors'   => array( 'Invalid API response format.' ),
            ) );
            return new WP_Error( 'invalid_response', __( 'Invalid API response format.', 'iconnect-sync' ) );
        }

        $articles      = $body['articles'];
        $authors        = isset( $body['authors'] ) ? $body['authors'] : array();
        $guest_writers  = isset( $body['guestWriters'] ) ? $body['guestWriters'] : array();

        $sync_cat_id   = (int) get_option( 'iconnect_sync_category', 0 );
        $sync_author   = (int) get_option( 'iconnect_sync_author', 0 );

        if ( ! $sync_author ) {
            $admins = get_users( array( 'role' => 'administrator', 'number' => 1, 'orderby' => 'ID', 'order' => 'ASC' ) );
            $sync_author = ! empty( $admins ) ? $admins[0]->ID : 1;
        }

        $created = 0;
        $updated = 0;
        $trashed = 0;
        $errors  = array();
        $synced_iconnect_ids = array();

        foreach ( $articles as $article ) {
            if ( empty( $article['id'] ) || empty( $article['title'] ) ) {
                $errors[] = 'Skipped article with missing id or title.';
                continue;
            }

            $iconnect_id = $article['id'];
            $synced_iconnect_ids[] = $iconnect_id;

            $author_name = $this->resolve_author_name( $article, $authors, $guest_writers );

            $author_handle = '';
            if ( ! empty( $article['author_id'] ) && isset( $authors[ $article['author_id'] ] ) ) {
                $author_handle = isset( $authors[ $article['author_id'] ]['handle'] ) ? $authors[ $article['author_id'] ]['handle'] : '';
            } elseif ( ! empty( $article['guest_writer_id'] ) ) {
                $author_handle = 'guest';
            }

            $article_url = $this->build_article_url( $api_url, $article, $author_handle );

            $existing_post = $this->get_post_by_iconnect_id( $iconnect_id );

            $post_data = array(
                'post_title'   => sanitize_text_field( $article['title'] ),
                'post_excerpt' => wp_kses_post( isset( $article['summary'] ) ? $article['summary'] : '' ),
                'post_status'  => 'publish',
                'post_type'    => 'post',
                'post_author'  => $sync_author,
            );

            if ( $existing_post ) {
                $post_data['ID'] = $existing_post->ID;
                $post_id = wp_update_post( $post_data, true );

                if ( is_wp_error( $post_id ) ) {
                    $errors[] = 'Failed to update article: ' . $article['title'] . ' - ' . $post_id->get_error_message();
                    continue;
                }

                $updated++;
            } else {
                $post_id = wp_insert_post( $post_data, true );

                if ( is_wp_error( $post_id ) ) {
                    $errors[] = 'Failed to create article: ' . $article['title'] . ' - ' . $post_id->get_error_message();
                    continue;
                }

                $created++;
            }

            update_post_meta( $post_id, '_iconnect_synced', '1' );
            update_post_meta( $post_id, '_iconnect_id', $iconnect_id );
            update_post_meta( $post_id, '_iconnect_author_name', sanitize_text_field( $author_name ) );
            update_post_meta( $post_id, '_iconnect_published_date', sanitize_text_field( isset( $article['published_date'] ) ? $article['published_date'] : '' ) );
            update_post_meta( $post_id, '_iconnect_slug', sanitize_text_field( isset( $article['slug'] ) ? $article['slug'] : '' ) );
            update_post_meta( $post_id, '_iconnect_url', esc_url_raw( $article_url ) );

            if ( $sync_cat_id ) {
                wp_set_post_categories( $post_id, array( $sync_cat_id ), true );
            }

            $tags = isset( $article['tags'] ) ? $article['tags'] : array();
            if ( ! empty( $tags ) && is_array( $tags ) ) {
                $tag_names = array_map( 'sanitize_text_field', $tags );
                wp_set_post_tags( $post_id, $tag_names, false );
            } else {
                wp_set_post_tags( $post_id, array() );
            }

            if ( ! empty( $article['feature_image_url'] ) ) {
                $this->sideload_featured_image( $post_id, $article['feature_image_url'], $article['title'] );
            }
        }

        $trashed = $this->trash_removed_articles( $synced_iconnect_ids );

        $status = array(
            'last_run'        => time(),
            'articles_synced' => count( $articles ),
            'created'         => $created,
            'updated'         => $updated,
            'trashed'         => $trashed,
            'errors'          => $errors,
        );

        $this->log_status( $status );

        return $status;
    }

    private function resolve_author_name( $article, $authors, $guest_writers ) {
        if ( ! empty( $article['author_id'] ) && isset( $authors[ $article['author_id'] ] ) ) {
            return $authors[ $article['author_id'] ]['name'];
        }

        if ( ! empty( $article['guest_writer_id'] ) && isset( $guest_writers[ $article['guest_writer_id'] ] ) ) {
            return $guest_writers[ $article['guest_writer_id'] ]['name'];
        }

        return '';
    }

    private function build_article_url( $api_url, $article, $author_handle ) {
        $base = rtrim( $api_url, '/' );
        $slug = isset( $article['slug'] ) ? $article['slug'] : '';

        if ( ! empty( $author_handle ) ) {
            return $base . '/articles/' . $author_handle . '/' . $slug;
        }

        return $base . '/articles/' . $slug;
    }

    private function get_post_by_iconnect_id( $iconnect_id ) {
        $posts = get_posts( array(
            'post_type'      => 'post',
            'post_status'    => array( 'publish', 'draft', 'trash' ),
            'meta_query'     => array(
                'relation' => 'AND',
                array(
                    'key'   => '_iconnect_synced',
                    'value' => '1',
                ),
                array(
                    'key'   => '_iconnect_id',
                    'value' => $iconnect_id,
                ),
            ),
            'posts_per_page' => 1,
        ) );

        return ! empty( $posts ) ? $posts[0] : null;
    }

    private function trash_removed_articles( $synced_ids ) {
        if ( empty( $synced_ids ) ) {
            return 0;
        }

        $all_synced_posts = get_posts( array(
            'post_type'      => 'post',
            'post_status'    => 'publish',
            'posts_per_page' => -1,
            'meta_key'       => '_iconnect_synced',
            'meta_value'     => '1',
            'fields'         => 'ids',
        ) );

        $trashed = 0;
        foreach ( $all_synced_posts as $post_id ) {
            $iconnect_id = get_post_meta( $post_id, '_iconnect_id', true );
            if ( ! in_array( $iconnect_id, $synced_ids ) ) {
                wp_trash_post( $post_id );
                $trashed++;
            }
        }

        return $trashed;
    }

    private function sideload_featured_image( $post_id, $image_url, $title ) {
        $current_thumb_id = get_post_thumbnail_id( $post_id );
        if ( $current_thumb_id ) {
            $current_url = get_post_meta( $current_thumb_id, '_iconnect_source_url', true );
            if ( $current_url === $image_url ) {
                return;
            }
        }

        require_once ABSPATH . 'wp-admin/includes/media.php';
        require_once ABSPATH . 'wp-admin/includes/file.php';
        require_once ABSPATH . 'wp-admin/includes/image.php';

        $tmp = download_url( $image_url );
        if ( is_wp_error( $tmp ) ) {
            return;
        }

        $file_array = array(
            'name'     => sanitize_file_name( basename( wp_parse_url( $image_url, PHP_URL_PATH ) ) ),
            'tmp_name' => $tmp,
        );

        $attachment_id = media_handle_sideload( $file_array, $post_id, sanitize_text_field( $title ) );

        if ( is_wp_error( $attachment_id ) ) {
            @unlink( $tmp );
            return;
        }

        set_post_thumbnail( $post_id, $attachment_id );
        update_post_meta( $attachment_id, '_iconnect_source_url', $image_url );
    }

    private function log_status( $status ) {
        update_option( 'iconnect_sync_last_status', $status, false );
    }
}
