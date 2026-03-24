<?php
/**
 * Plugin Name: iConnect Content Sync
 * Plugin URI: https://iconn.app
 * Description: Syncs news articles from an iConnect instance into WordPress as a custom post type for SEO indexing and visitor discovery.
 * Version: 1.0.0
 * Author: iConnect
 * Author URI: https://iconn.app
 * License: GPL v2 or later
 * License URI: https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain: iconnect-sync
 */

if ( ! defined( 'ABSPATH' ) ) {
    exit;
}

define( 'ICONNECT_SYNC_VERSION', '1.0.0' );
define( 'ICONNECT_SYNC_PLUGIN_DIR', plugin_dir_path( __FILE__ ) );
define( 'ICONNECT_SYNC_PLUGIN_URL', plugin_dir_url( __FILE__ ) );
define( 'ICONNECT_SYNC_PLUGIN_BASENAME', plugin_basename( __FILE__ ) );

require_once ICONNECT_SYNC_PLUGIN_DIR . 'includes/class-settings.php';
require_once ICONNECT_SYNC_PLUGIN_DIR . 'includes/class-post-type.php';
require_once ICONNECT_SYNC_PLUGIN_DIR . 'includes/class-sync-engine.php';
require_once ICONNECT_SYNC_PLUGIN_DIR . 'includes/class-webhook.php';
require_once ICONNECT_SYNC_PLUGIN_DIR . 'includes/class-shortcode.php';
require_once ICONNECT_SYNC_PLUGIN_DIR . 'includes/class-block.php';
require_once ICONNECT_SYNC_PLUGIN_DIR . 'includes/class-seo.php';

final class IConnect_Sync {

    private static $instance = null;

    public static function instance() {
        if ( null === self::$instance ) {
            self::$instance = new self();
        }
        return self::$instance;
    }

    private function __construct() {
        new IConnect_Sync_Settings();
        new IConnect_Sync_Post_Type();
        new IConnect_Sync_Engine();
        new IConnect_Sync_Webhook();
        new IConnect_Sync_Shortcode();
        new IConnect_Sync_Block();
        new IConnect_Sync_SEO();

        register_activation_hook( __FILE__, array( $this, 'activate' ) );
        register_deactivation_hook( __FILE__, array( $this, 'deactivate' ) );
    }

    public function activate() {
        $post_type = new IConnect_Sync_Post_Type();
        $post_type->register_post_type();
        $post_type->register_taxonomy();
        flush_rewrite_rules();

        $defaults = array(
            'iconnect_sync_api_url'    => '',
            'iconnect_sync_api_key'    => '',
            'iconnect_sync_frequency'  => 'hourly',
        );
        foreach ( $defaults as $key => $value ) {
            if ( false === get_option( $key ) ) {
                add_option( $key, $value );
            }
        }

        $engine = new IConnect_Sync_Engine();
        $engine->schedule_sync();
    }

    public function deactivate() {
        wp_clear_scheduled_hook( 'iconnect_sync_cron_event' );
        flush_rewrite_rules();
    }
}

IConnect_Sync::instance();
