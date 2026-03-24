<?php
if ( ! defined( 'ABSPATH' ) ) {
    exit;
}

class IConnect_Sync_Settings {

    public function __construct() {
        add_action( 'admin_menu', array( $this, 'add_settings_page' ) );
        add_action( 'admin_init', array( $this, 'register_settings' ) );
        add_action( 'admin_enqueue_scripts', array( $this, 'enqueue_admin_assets' ) );
        add_action( 'wp_ajax_iconnect_sync_now', array( $this, 'ajax_sync_now' ) );
    }

    public function add_settings_page() {
        add_options_page(
            __( 'iConnect Sync Settings', 'iconnect-sync' ),
            __( 'iConnect Sync', 'iconnect-sync' ),
            'manage_options',
            'iconnect-sync',
            array( $this, 'render_settings_page' )
        );
    }

    public function register_settings() {
        register_setting( 'iconnect_sync_settings', 'iconnect_sync_api_url', array(
            'type'              => 'string',
            'sanitize_callback' => 'esc_url_raw',
            'default'           => '',
        ) );
        register_setting( 'iconnect_sync_settings', 'iconnect_sync_api_key', array(
            'type'              => 'string',
            'sanitize_callback' => 'sanitize_text_field',
            'default'           => '',
        ) );
        register_setting( 'iconnect_sync_settings', 'iconnect_sync_frequency', array(
            'type'              => 'string',
            'sanitize_callback' => array( $this, 'sanitize_frequency' ),
            'default'           => 'hourly',
        ) );
        register_setting( 'iconnect_sync_settings', 'iconnect_sync_category', array(
            'type'              => 'integer',
            'sanitize_callback' => 'absint',
            'default'           => 0,
        ) );
        register_setting( 'iconnect_sync_settings', 'iconnect_sync_author', array(
            'type'              => 'integer',
            'sanitize_callback' => 'absint',
            'default'           => 0,
        ) );

        add_settings_section(
            'iconnect_sync_main',
            __( 'Connection Settings', 'iconnect-sync' ),
            null,
            'iconnect-sync'
        );

        add_settings_section(
            'iconnect_sync_post',
            __( 'Post Settings', 'iconnect-sync' ),
            null,
            'iconnect-sync'
        );

        add_settings_field( 'iconnect_sync_api_url', __( 'iConnect API URL', 'iconnect-sync' ), array( $this, 'render_api_url_field' ), 'iconnect-sync', 'iconnect_sync_main' );
        add_settings_field( 'iconnect_sync_api_key', __( 'API Key', 'iconnect-sync' ), array( $this, 'render_api_key_field' ), 'iconnect-sync', 'iconnect_sync_main' );
        add_settings_field( 'iconnect_sync_frequency', __( 'Sync Frequency', 'iconnect-sync' ), array( $this, 'render_frequency_field' ), 'iconnect-sync', 'iconnect_sync_main' );
        add_settings_field( 'iconnect_sync_category', __( 'Sync Category', 'iconnect-sync' ), array( $this, 'render_category_field' ), 'iconnect-sync', 'iconnect_sync_post' );
        add_settings_field( 'iconnect_sync_author', __( 'Post Author', 'iconnect-sync' ), array( $this, 'render_author_field' ), 'iconnect-sync', 'iconnect_sync_post' );
    }

    public function sanitize_frequency( $value ) {
        $valid = array( 'iconnect_15min', 'hourly', 'twicedaily', 'daily' );
        return in_array( $value, $valid, true ) ? $value : 'hourly';
    }

    public function render_api_url_field() {
        $value = get_option( 'iconnect_sync_api_url', '' );
        echo '<input type="url" name="iconnect_sync_api_url" value="' . esc_attr( $value ) . '" class="regular-text" placeholder="https://your-tenant.iconn.app" />';
        echo '<p class="description">' . esc_html__( 'The base URL of your iConnect instance (e.g., https://your-tenant.iconn.app).', 'iconnect-sync' ) . '</p>';
    }

    public function render_api_key_field() {
        $value = get_option( 'iconnect_sync_api_key', '' );
        echo '<input type="password" name="iconnect_sync_api_key" value="' . esc_attr( $value ) . '" class="regular-text" autocomplete="new-password" />';
        echo '<p class="description">' . esc_html__( 'API key for webhook validation. Also used for future authenticated API access.', 'iconnect-sync' ) . '</p>';
    }

    public function render_frequency_field() {
        $value = get_option( 'iconnect_sync_frequency', 'hourly' );
        $options = array(
            'iconnect_15min' => __( 'Every 15 minutes', 'iconnect-sync' ),
            'hourly'         => __( 'Hourly', 'iconnect-sync' ),
            'twicedaily'     => __( 'Twice Daily', 'iconnect-sync' ),
            'daily'          => __( 'Daily', 'iconnect-sync' ),
        );
        echo '<select name="iconnect_sync_frequency">';
        foreach ( $options as $key => $label ) {
            echo '<option value="' . esc_attr( $key ) . '"' . selected( $value, $key, false ) . '>' . esc_html( $label ) . '</option>';
        }
        echo '</select>';
    }

    public function render_category_field() {
        $value = (int) get_option( 'iconnect_sync_category', 0 );
        $categories = get_categories( array(
            'hide_empty' => false,
            'orderby'    => 'name',
            'order'      => 'ASC',
        ) );

        echo '<select name="iconnect_sync_category">';
        echo '<option value="0"' . selected( $value, 0, false ) . '>' . esc_html__( '— No category —', 'iconnect-sync' ) . '</option>';
        foreach ( $categories as $cat ) {
            echo '<option value="' . esc_attr( $cat->term_id ) . '"' . selected( $value, $cat->term_id, false ) . '>' . esc_html( $cat->name ) . '</option>';
        }
        echo '</select>';
        echo '<p class="description">' . esc_html__( 'WordPress category to assign to synced articles. An "iConnect" category is created automatically on activation.', 'iconnect-sync' ) . '</p>';
    }

    public function render_author_field() {
        $value = (int) get_option( 'iconnect_sync_author', 0 );
        $users = get_users( array(
            'capability' => 'publish_posts',
            'orderby'    => 'display_name',
            'order'      => 'ASC',
        ) );

        echo '<select name="iconnect_sync_author">';
        echo '<option value="0"' . selected( $value, 0, false ) . '>' . esc_html__( '— Default (site admin) —', 'iconnect-sync' ) . '</option>';
        foreach ( $users as $user ) {
            echo '<option value="' . esc_attr( $user->ID ) . '"' . selected( $value, $user->ID, false ) . '>' . esc_html( $user->display_name ) . ' (' . esc_html( $user->user_login ) . ')</option>';
        }
        echo '</select>';
        echo '<p class="description">' . esc_html__( 'WordPress user to set as author on synced posts.', 'iconnect-sync' ) . '</p>';
    }

    public function enqueue_admin_assets( $hook ) {
        if ( 'settings_page_iconnect-sync' !== $hook ) {
            return;
        }
        wp_enqueue_style( 'iconnect-sync-admin', ICONNECT_SYNC_PLUGIN_URL . 'assets/css/admin.css', array(), ICONNECT_SYNC_VERSION );
        wp_enqueue_script( 'iconnect-sync-admin', ICONNECT_SYNC_PLUGIN_URL . 'assets/js/admin.js', array( 'jquery' ), ICONNECT_SYNC_VERSION, true );
        wp_localize_script( 'iconnect-sync-admin', 'iconnectSync', array(
            'ajaxUrl' => admin_url( 'admin-ajax.php' ),
            'nonce'   => wp_create_nonce( 'iconnect_sync_now' ),
            'syncing' => __( 'Syncing...', 'iconnect-sync' ),
            'done'    => __( 'Sync Now', 'iconnect-sync' ),
        ) );
    }

    public function ajax_sync_now() {
        check_ajax_referer( 'iconnect_sync_now', 'nonce' );

        if ( ! current_user_can( 'manage_options' ) ) {
            wp_send_json_error( __( 'Permission denied.', 'iconnect-sync' ) );
        }

        $engine = new IConnect_Sync_Engine();
        $result = $engine->run_sync();

        if ( is_wp_error( $result ) ) {
            wp_send_json_error( $result->get_error_message() );
        }

        wp_send_json_success( $result );
    }

    public function render_settings_page() {
        if ( ! current_user_can( 'manage_options' ) ) {
            return;
        }

        $status = get_option( 'iconnect_sync_last_status', array() );
        ?>
        <div class="wrap">
            <h1><?php echo esc_html( get_admin_page_title() ); ?></h1>

            <form method="post" action="options.php">
                <?php
                settings_fields( 'iconnect_sync_settings' );
                do_settings_sections( 'iconnect-sync' );
                submit_button();
                ?>
            </form>

            <hr />

            <h2><?php esc_html_e( 'Sync Controls', 'iconnect-sync' ); ?></h2>
            <p>
                <button type="button" id="iconnect-sync-now" class="button button-primary">
                    <?php esc_html_e( 'Sync Now', 'iconnect-sync' ); ?>
                </button>
                <span id="iconnect-sync-result" class="iconnect-sync-result"></span>
            </p>

            <h2><?php esc_html_e( 'Sync Status', 'iconnect-sync' ); ?></h2>
            <div class="iconnect-sync-status-card">
                <table class="widefat striped">
                    <tbody>
                        <tr>
                            <th><?php esc_html_e( 'Last Sync', 'iconnect-sync' ); ?></th>
                            <td>
                                <?php
                                if ( ! empty( $status['last_run'] ) ) {
                                    echo esc_html( wp_date( 'F j, Y g:i:s A', $status['last_run'] ) );
                                } else {
                                    esc_html_e( 'Never', 'iconnect-sync' );
                                }
                                ?>
                            </td>
                        </tr>
                        <tr>
                            <th><?php esc_html_e( 'Articles Synced', 'iconnect-sync' ); ?></th>
                            <td><?php echo esc_html( isset( $status['articles_synced'] ) ? $status['articles_synced'] : '0' ); ?></td>
                        </tr>
                        <tr>
                            <th><?php esc_html_e( 'Articles Created', 'iconnect-sync' ); ?></th>
                            <td><?php echo esc_html( isset( $status['created'] ) ? $status['created'] : '0' ); ?></td>
                        </tr>
                        <tr>
                            <th><?php esc_html_e( 'Articles Updated', 'iconnect-sync' ); ?></th>
                            <td><?php echo esc_html( isset( $status['updated'] ) ? $status['updated'] : '0' ); ?></td>
                        </tr>
                        <tr>
                            <th><?php esc_html_e( 'Articles Trashed', 'iconnect-sync' ); ?></th>
                            <td><?php echo esc_html( isset( $status['trashed'] ) ? $status['trashed'] : '0' ); ?></td>
                        </tr>
                        <tr>
                            <th><?php esc_html_e( 'Errors', 'iconnect-sync' ); ?></th>
                            <td>
                                <?php
                                if ( ! empty( $status['errors'] ) ) {
                                    echo '<ul class="iconnect-sync-errors">';
                                    foreach ( (array) $status['errors'] as $error ) {
                                        echo '<li>' . esc_html( $error ) . '</li>';
                                    }
                                    echo '</ul>';
                                } else {
                                    esc_html_e( 'None', 'iconnect-sync' );
                                }
                                ?>
                            </td>
                        </tr>
                    </tbody>
                </table>
            </div>

            <h3><?php esc_html_e( 'Webhook URL', 'iconnect-sync' ); ?></h3>
            <p class="description">
                <?php esc_html_e( 'Configure iConnect to send webhook notifications to this URL for immediate sync:', 'iconnect-sync' ); ?>
            </p>
            <code><?php echo esc_html( rest_url( 'iconnect-sync/v1/webhook' ) ); ?></code>
        </div>
        <?php
    }
}
